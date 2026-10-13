const DEFAULT_API_ORIGIN = "http://127.0.0.1:8765";
const tabGenerations = new Map();
const tabLeases = new Map();
const LEASE_STORE_KEY = "zkActiveLeases";
const ready = chrome.storage.session.get(LEASE_STORE_KEY).then((stored) => {
  for (const [tabId, entries] of Object.entries(stored[LEASE_STORE_KEY] || {})) {
    tabLeases.set(Number(tabId), new Map(entries.map(([leaseId, lease]) => [
      leaseId,
      typeof lease === "string"
        ? { jobId: lease, origin: DEFAULT_API_ORIGIN, token: "" }
        : lease,
    ])));
  }
}).catch(() => {});
let persistence = Promise.resolve();

function persistLeases() {
  const snapshot = Object.fromEntries([...tabLeases].map(([tabId, entries]) => [tabId, [...entries]]));
  persistence = persistence
    .catch(() => {})
    .then(() => chrome.storage.session.set({ [LEASE_STORE_KEY]: snapshot }))
    .catch(() => {});
  return persistence;
}

const allowedPaths = [
  /^\/api\/status$/,
  /^\/api\/videos\/BV[0-9A-Za-z]{10}-p[1-9][0-9]*$/,
  /^\/api\/analyze$/,
  /^\/api\/import-course-summary$/,
  /^\/api\/jobs\/[a-zA-Z0-9-]+$/,
  /^\/api\/jobs\/[a-zA-Z0-9-]+\/cancel$/,
];

function normalizeOrigin(value) {
  const url = new URL(value || DEFAULT_API_ORIGIN);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && url.origin !== DEFAULT_API_ORIGIN)) {
    throw new Error("服务地址无效，请在扩展设置中填写 HTTPS 地址。");
  }
  return url.origin;
}

async function apiConfig() {
  const values = await chrome.storage.local.get(["zkApiOrigin", "zkAccessToken"]);
  const origin = normalizeOrigin(values.zkApiOrigin);
  const token = values.zkAccessToken || "";
  if (typeof token !== "string" || /[\r\n]/.test(token)) {
    throw new Error("访问令牌无效，请在扩展设置中重新填写。");
  }
  return { origin, token };
}

function apiFetch(config, path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (config.token) headers.Authorization = `Bearer ${config.token}`;
  return fetch(`${config.origin}${path}`, {
    ...options, headers, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
  });
}

function openDashboard() {
  apiConfig()
    .then(({ origin }) => chrome.tabs.create({ url: origin }))
    .catch(() => chrome.runtime.openOptionsPage());
}

chrome.action.onClicked.addListener(openDashboard);

function releaseLease(lease, leaseId) {
  return apiFetch(lease, `/api/jobs/${encodeURIComponent(lease.jobId)}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lease_id: leaseId }),
  }).catch(() => {});
}

async function releaseTab(tabId) {
  tabGenerations.set(tabId, (tabGenerations.get(tabId) || 0) + 1);
  await ready;
  const leases = tabLeases.get(tabId);
  tabLeases.delete(tabId);
  await persistLeases();
  for (const [leaseId, lease] of leases || []) releaseLease(lease, leaseId);
}

chrome.tabs.onRemoved.addListener((tabId) => { releaseTab(tabId).catch(() => {}); });
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading") releaseTab(tabId).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.kind === "open-dashboard") {
    openDashboard();
    return false;
  }
  if (message?.kind === "open-options") {
    chrome.runtime.openOptionsPage();
    return false;
  }
  if (message?.kind !== "api") return false;
  const method = message.method === "POST" ? "POST" : "GET";
  const path = message.path;
  const tabId = sender.tab?.id;
  const generation = tabId === undefined ? null : (tabGenerations.get(tabId) || 0);
  if (typeof path !== "string" || !allowedPaths.some((pattern) => pattern.test(path))) {
    reply({ ok: false, error: "无效的请求地址。" });
    return false;
  }
  if (method === "POST" && path !== "/api/analyze" && path !== "/api/import-course-summary" && !/^\/api\/jobs\/[a-zA-Z0-9-]+\/cancel$/.test(path)) {
    reply({ ok: false, error: "不支持此操作。" });
    return false;
  }

  const options = { method };
  if (method === "POST") {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(message.body ?? {});
  }

  apiConfig()
    .then((config) => apiFetch(config, path, options).then((response) => ({ response, config })))
    .then(async ({ response, config }) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(typeof data.detail === "string" ? data.detail : (data.error || `请求失败 (${response.status})`));
        error.status = response.status;
        throw error;
      }
      if (tabId !== undefined && method === "POST" && path === "/api/analyze" && data.lease_id) {
        await ready;
        if ((tabGenerations.get(tabId) || 0) !== generation) {
          await releaseLease({ jobId: data.job_id, ...config }, data.lease_id);
        } else {
          if (!tabLeases.has(tabId)) tabLeases.set(tabId, new Map());
          tabLeases.get(tabId).set(data.lease_id, { jobId: data.job_id, ...config });
          await persistLeases();
        }
      }
      if (tabId !== undefined && method === "POST" && path.endsWith("/cancel") && message.body?.lease_id) {
        await ready;
        const leases = tabLeases.get(tabId);
        leases?.delete(message.body.lease_id);
        if (leases?.size === 0) tabLeases.delete(tabId);
        await persistLeases();
      }
      if (tabId !== undefined && method === "GET" && /^\/api\/jobs\/[a-zA-Z0-9-]+$/.test(path) && ["done", "error", "cancelled"].includes(data.status)) {
        await ready;
        const jobId = path.split("/")[3];
        const leases = tabLeases.get(tabId);
        for (const [leaseId, lease] of leases || []) {
          if (lease.jobId === jobId) leases.delete(leaseId);
        }
        if (leases?.size === 0) tabLeases.delete(tabId);
        await persistLeases();
      }
      reply({ ok: true, data });
    })
    .catch((error) => {
      const messageText = error instanceof TypeError
        ? "无法连接知点服务。请检查服务地址、网络和扩展站点权限。"
        : error.message;
      reply({ ok: false, error: messageText, status: error.status });
    });
  return true;
});
