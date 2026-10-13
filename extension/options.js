const DEFAULT_API_ORIGIN = "http://127.0.0.1:8765";
const form = document.getElementById("connection-form");
const originInput = document.getElementById("origin");
const tokenInput = document.getElementById("token");
const status = document.getElementById("status");
const saveButton = document.getElementById("save");
const localButton = document.getElementById("use-local");
const toggleButton = document.getElementById("toggle-token");

function showStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

function parseOrigin(value) {
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("请输入完整的服务地址。");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && url.origin !== DEFAULT_API_ORIGIN)) {
    throw new Error("云端地址必须是 HTTPS 根地址；本地地址请使用默认地址。");
  }
  return url.origin;
}

async function checkConnection(origin, token) {
  try {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const response = await fetch(`${origin}/api/status`, {
      headers, cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "no-referrer",
    });
    if (response.status === 401 || response.status === 403) {
      showStatus("设置已保存，但访问令牌未通过验证。", true);
    } else if (!response.ok) {
      showStatus(`设置已保存，但服务返回 HTTP ${response.status}。`, true);
    } else {
      showStatus("设置已保存，服务连接正常。请刷新已打开的 B 站视频页。");
    }
  } catch {
    showStatus("设置已保存，但目前无法连接服务。请检查地址和服务状态。", true);
  }
}

async function saveSettings(event) {
  event.preventDefault();
  let origin;
  const token = tokenInput.value.trim();
  try {
    origin = parseOrigin(originInput.value);
    if (/[\r\n]/.test(token)) throw new Error("访问令牌不能包含换行符。");
    if (origin !== DEFAULT_API_ORIGIN && !token) throw new Error("云端服务需要访问令牌。");
  } catch (error) {
    showStatus(error.message, true);
    return;
  }

  saveButton.disabled = true;
  showStatus("正在保存连接设置…");
  try {
    if (origin !== DEFAULT_API_ORIGIN) {
      const hostname = new URL(origin).hostname;
      const granted = await chrome.permissions.request({ origins: [`https://${hostname}/*`] });
      if (!granted) {
        showStatus("请允许扩展访问该服务地址，然后重新保存。", true);
        return;
      }
    }
    await chrome.storage.local.set({ zkApiOrigin: origin, zkAccessToken: token });
    await checkConnection(origin, token);
  } catch {
    showStatus("保存失败，请检查扩展权限后重试。", true);
  } finally {
    saveButton.disabled = false;
  }
}

form.addEventListener("submit", saveSettings);
localButton.addEventListener("click", () => {
  originInput.value = DEFAULT_API_ORIGIN;
  tokenInput.value = "";
  showStatus("已选择本地服务。点击“保存并检查连接”应用设置。");
});
toggleButton.addEventListener("click", () => {
  const visible = tokenInput.type === "password";
  tokenInput.type = visible ? "text" : "password";
  toggleButton.textContent = visible ? "隐藏" : "显示";
  toggleButton.setAttribute("aria-label", visible ? "隐藏访问令牌" : "显示访问令牌");
  toggleButton.setAttribute("aria-pressed", String(visible));
});

chrome.storage.local.get(["zkApiOrigin", "zkAccessToken"]).then((values) => {
  originInput.value = values.zkApiOrigin || DEFAULT_API_ORIGIN;
  tokenInput.value = values.zkAccessToken || "";
}).catch(() => showStatus("无法读取扩展设置，请重新打开设置页。", true));
