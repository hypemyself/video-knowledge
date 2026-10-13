"use strict";

const $ = (selector) => document.querySelector(selector);
const ACCESS_TOKEN_KEY = "zhidian-access-token";

function savedAccessToken() {
  try { return sessionStorage.getItem(ACCESS_TOKEN_KEY) || ""; }
  catch { return ""; }
}

const state = {
  accessToken: savedAccessToken(),
  authenticated: false,
  videos: [],
  selectedId: null,
  selectedVideo: null,
  activeCategory: "全部",
  configured: false,
  jobId: null,
  jobLeaseId: null,
  jobUrl: null,
  jobTimer: null,
  pendingTranscriptionUrl: null,
  partialSignature: "",
  searchResults: [],
  searchError: "",
  searchPending: false,
  searchTimer: null,
  searchRequestId: 0,
  loadingDetail: false,
  detailRequestId: 0,
  listError: false,
};

const elements = {
  bootView: $("#boot-view"),
  bootMessage: $("#boot-message"),
  retryConnection: $("#retry-connection"),
  authView: $("#auth-view"),
  authForm: $("#auth-form"),
  authError: $("#auth-error"),
  authSubmit: $("#auth-submit"),
  appShell: $("#app-shell"),
  signoutButton: $("#signout-button"),
  libraryView: $("#library-view"),
  settingsView: $("#settings-view"),
  breadcrumb: $("#breadcrumb-current"),
  sidebarStatus: $("#sidebar-status"),
  libraryCount: $("#library-count"),
  videoListCount: $("#video-list-count"),
  videoList: $("#video-list"),
  videoSearch: $("#video-search"),
  detailColumn: $("#detail-column"),
  detailEmpty: $("#detail-empty"),
  videoDetail: $("#video-detail"),
  analyzeForm: $("#analyze-form"),
  analyzeButton: $("#analyze-button"),
  formError: $("#form-error"),
  setupBanner: $("#setup-banner"),
  jobPanel: $("#job-panel"),
  jobIcon: $("#job-icon"),
  jobTitle: $("#job-title"),
  jobProgress: $("#job-progress"),
  dismissJob: $("#dismiss-job"),
  cancelJob: $("#cancel-job"),
  confirmTranscription: $("#confirm-transcription"),
  partialPanel: $("#partial-panel"),
  settingsForm: $("#settings-form"),
  settingsError: $("#settings-error"),
  settingsSaved: $("#settings-saved"),
  saveSettings: $("#save-settings"),
  keyState: $("#key-state"),
};

function node(tag, className = "", text = "") {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text) item.textContent = text;
  return item;
}

function errorText(value, fallback = "请求失败，请稍后重试。") {
  if (typeof value === "string" && value.trim()) return value;
  if (value && typeof value === "object" && typeof value.message === "string") return value.message;
  return fallback;
}

async function request(path, options = {}) {
  const { accessToken = state.accessToken, suppressAuthLock = false, headers = {}, ...fetchOptions } = options;
  const requestHeaders = new Headers(headers);
  if (fetchOptions.body !== undefined && !requestHeaders.has("Content-Type")) requestHeaders.set("Content-Type", "application/json");
  if (path.startsWith("/api/") && accessToken) requestHeaders.set("Authorization", `Bearer ${accessToken}`);
  let response;
  try {
    response = await fetch(path, {
      cache: "no-store",
      ...fetchOptions,
      headers: requestHeaders,
    });
  } catch {
    throw new Error("无法连接服务，请稍后重试。");
  }
  if (response.status === 401 && !suppressAuthLock) lockApp();
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(errorText(body?.error || body?.detail, `请求失败（HTTP ${response.status}）。`));
    error.status = response.status;
    throw error;
  }
  return body;
}

function lockApp() {
  const expired = Boolean(state.accessToken);
  state.accessToken = "";
  state.authenticated = false;
  try { sessionStorage.removeItem(ACCESS_TOKEN_KEY); } catch { /* Storage may be disabled. */ }
  if (state.jobTimer) clearTimeout(state.jobTimer);
  if (state.searchTimer) clearTimeout(state.searchTimer);
  state.jobTimer = null;
  state.searchTimer = null;
  state.jobId = null;
  state.videos = [];
  state.selectedVideo = null;
  state.searchResults = [];
  ++state.detailRequestId;
  ++state.searchRequestId;
  elements.videoList.replaceChildren();
  elements.videoDetail.replaceChildren();
  elements.partialPanel.replaceChildren();
  elements.settingsForm.reset();
  elements.appShell.hidden = true;
  elements.bootView.hidden = true;
  elements.authView.hidden = false;
  elements.authError.textContent = expired ? "登录已失效，请重新输入访问令牌。" : "";
  elements.authError.hidden = !expired;
  $("#access-token").focus();
}

function formatTime(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remaining = value % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}` : `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function videoUrl(raw) {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (!(["http:", "https:"].includes(url.protocol) && (host === "bilibili.com" || host.endsWith(".bilibili.com") || host === "b23.tv"))) return null;
    return url;
  } catch {
    return null;
  }
}

function timedUrl(raw, seconds) {
  const url = videoUrl(raw);
  if (!url) return null;
  url.searchParams.set("t", String(Math.max(0, Math.floor(Number(seconds) || 0))));
  return url.href;
}

function videoId(video) { return String(video?.id ?? video?.video_id ?? ""); }
function evidenceLabel(source) { return source === "bilibili_course_summary" ? "摘要依据" : "原话"; }
function videoCount(video) {
  const count = video?.points_count ?? video?.point_count ?? video?.knowledge_point_count;
  return Number.isFinite(Number(count)) ? Number(count) : (Array.isArray(video?.points) ? video.points.length : 0);
}

function setServiceStatus(kind, text) {
  elements.sidebarStatus.className = `service-status ${kind ? `is-${kind}` : ""}`;
  elements.sidebarStatus.lastChild.textContent = text;
}

function applyStatus(result) {
  state.configured = Boolean(result?.configured);
  elements.setupBanner.hidden = state.configured;
  setServiceStatus(state.configured ? "ready" : "error", state.configured ? "AI 服务已配置" : "等待配置 AI 服务");
}

async function loadStatus() {
  try {
    applyStatus(await request("/api/status"));
  } catch (error) {
    if (error.status === 401) return;
    setServiceStatus("error", "服务不可用");
    elements.setupBanner.hidden = true;
    showFormError(error.message);
  }
}

function showFormError(message) {
  elements.formError.textContent = message;
  elements.formError.hidden = !message;
}

function showSettingsError(message) {
  elements.settingsError.textContent = message;
  elements.settingsError.hidden = !message;
}

function setView(view) {
  if (!state.authenticated) return;
  const settings = view === "settings";
  elements.libraryView.hidden = settings;
  elements.settingsView.hidden = !settings;
  elements.breadcrumb.textContent = settings ? "AI 设置" : "知识库";
  document.querySelectorAll("[data-view]").forEach((button) => {
    const selected = button.dataset.view === view;
    button.classList.toggle("is-active", selected);
    if (selected) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  if (settings) loadSettings();
}

function navigate(view) {
  if (location.hash !== `#${view}`) location.hash = view;
  else setView(view);
}

function libraryRecords(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.videos)) return data.videos;
  return [];
}

async function loadVideos(preferredId = null, refreshDetail = true) {
  try {
    const latestVideos = libraryRecords(await request("/api/videos"));
    const listChanged = JSON.stringify(latestVideos) !== JSON.stringify(state.videos);
    state.videos = latestVideos;
    const count = state.videos.length;
    const points = state.videos.reduce((total, item) => total + videoCount(item), 0);
    elements.libraryCount.textContent = `已整理 ${count} 个视频${points ? ` · ${points} 个知识点` : ""}`;
    elements.videoListCount.textContent = String(count);
    const ids = state.videos.map(videoId);
    const chosen = preferredId && ids.includes(String(preferredId)) ? String(preferredId) :
      (state.selectedId && ids.includes(state.selectedId) ? state.selectedId : (ids[0] || null));
    if (!chosen) {
      state.selectedId = null;
      state.selectedVideo = null;
      elements.detailEmpty.hidden = false;
      elements.videoDetail.hidden = true;
    }
    if (listChanged || refreshDetail || state.listError) renderVideoList();
    state.listError = false;
    const summary = state.videos.find((item) => videoId(item) === chosen);
    const detailChanged = summary && state.selectedVideo && (
      summary.created_at !== state.selectedVideo.created_at || videoCount(summary) !== videoCount(state.selectedVideo)
    );
    if (chosen && (refreshDetail || chosen !== state.selectedId || !state.selectedVideo || detailChanged)) {
      await selectVideo(chosen, false, chosen === state.selectedId);
    }
  } catch (error) {
    state.listError = true;
    elements.libraryCount.textContent = "读取失败";
    elements.videoList.replaceChildren(listMessage("无法读取视频", error.message));
  }
}

function listMessage(title, detail = "") {
  const box = node("div", "list-message");
  box.append(node("strong", "", title));
  if (detail) box.append(node("span", "", detail));
  return box;
}

function renderVideoList() {
  const query = elements.videoSearch.value.trim().toLocaleLowerCase();
  if (query) {
    renderSearchResults(query);
    return;
  }
  const matches = state.videos;
  if (!matches.length) {
    elements.videoList.replaceChildren(listMessage(query ? "没有匹配的视频" : "暂无视频", query ? "试试其他关键词。" : "在上方粘贴视频链接开始整理。"));
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const video of matches) {
    const id = videoId(video);
    const row = node("button", `video-row${id === state.selectedId ? " is-selected" : ""}`);
    row.type = "button";
    row.setAttribute("aria-pressed", String(id === state.selectedId));
    row.addEventListener("click", () => selectVideo(id, true));
    const thumbnail = node("span", "video-thumbnail", "▶");
    const imageUrl = video.cover || video.thumbnail || video.pic;
    if (typeof imageUrl === "string" && /^https?:\/\//i.test(imageUrl)) {
      const image = node("img");
      image.src = imageUrl;
      image.alt = "";
      image.loading = "lazy";
      image.referrerPolicy = "no-referrer";
      image.addEventListener("load", () => { thumbnail.textContent = ""; thumbnail.append(image); });
    }
    const content = node("span", "video-row-content");
    content.append(node("span", "video-row-title", video.title || "未命名视频"));
    const meta = [videoCount(video) ? `${videoCount(video)} 个知识点` : "待整理", formatDate(video.created_at || video.updated_at)].filter(Boolean).join(" · ");
    content.append(node("span", "video-row-meta", meta));
    row.append(thumbnail, content);
    fragment.append(row);
  }
  elements.videoList.replaceChildren(fragment);
}

function renderSearchResults(query) {
  if (state.searchPending) {
    elements.videoList.replaceChildren(listMessage("正在搜索…"));
    return;
  }
  if (state.searchError) {
    elements.videoList.replaceChildren(listMessage("搜索失败", state.searchError));
    return;
  }
  const titles = state.videos.filter((video) => String(video.title || "").toLocaleLowerCase().includes(query));
  const pointMatches = state.searchResults;
  if (!titles.length && !pointMatches.length) {
    elements.videoList.replaceChildren(listMessage("没有匹配的内容", "试试视频标题、知识点或分类。"));
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const video of titles) {
    const button = node("button", "search-row");
    button.type = "button";
    button.append(node("span", "search-kind", "视频"), node("strong", "search-title", video.title || "未命名视频"));
    button.addEventListener("click", () => selectVideo(videoId(video), true));
    fragment.append(button);
  }
  for (const result of pointMatches) {
    const point = result.point || {};
    const row = node("div", "search-result");
    const target = timedUrl(result.video_url, point.time_seconds);
    const primary = node(target ? "a" : "button", "search-row");
    if (target) {
      primary.href = target;
      primary.target = "_blank";
      primary.rel = "noopener noreferrer";
      primary.title = `在 ${formatTime(point.time_seconds)} 打开视频`;
    } else {
      primary.type = "button";
      primary.addEventListener("click", () => selectVideo(result.video_id, true, false, point.id));
    }
    primary.append(
      node("span", "search-kind", `${formatTime(point.time_seconds)} · ${point.category || "未分类"}`),
      node("strong", "search-title", point.title || "未命名知识点"),
      node("span", "search-video", result.video_title || "未命名视频"),
    );
    row.append(primary);
    if (target) {
      const note = node("button", "search-note", "查看笔记");
      note.type = "button";
      note.addEventListener("click", () => selectVideo(result.video_id, true, false, point.id));
      row.append(note);
    }
    fragment.append(row);
  }
  elements.videoList.replaceChildren(fragment);
}

async function searchLibrary() {
  if (!state.authenticated) return;
  const query = elements.videoSearch.value.trim();
  const requestId = ++state.searchRequestId;
  if (!query) {
    state.searchResults = [];
    state.searchError = "";
    state.searchPending = false;
    renderVideoList();
    return;
  }
  state.searchPending = true;
  renderVideoList();
  try {
    const result = await request(`/api/search?q=${encodeURIComponent(query)}`);
    if (requestId !== state.searchRequestId) return;
    state.searchResults = Array.isArray(result?.results) ? result.results : [];
    state.searchError = "";
  } catch (error) {
    if (requestId !== state.searchRequestId) return;
    state.searchResults = [];
    state.searchError = error.message;
  }
  state.searchPending = false;
  renderVideoList();
}

async function selectVideo(id, scrollToDetail = false, preserveCategory = false, pointId = null) {
  const requestId = ++state.detailRequestId;
  state.selectedId = String(id);
  state.selectedVideo = null;
  if (!preserveCategory) state.activeCategory = "全部";
  renderVideoList();
  elements.detailEmpty.hidden = true;
  elements.videoDetail.hidden = false;
  elements.videoDetail.replaceChildren(node("div", "detail-body detail-message", "正在读取知识点…"));
  state.loadingDetail = true;
  try {
    const result = await request(`/api/videos/${encodeURIComponent(id)}`);
    if (state.detailRequestId !== requestId) return;
    state.selectedVideo = result;
    renderDetail();
    if (pointId) {
      const target = [...elements.videoDetail.querySelectorAll("[data-point-id]")]
        .find((item) => item.dataset.pointId === String(pointId));
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.classList.add("is-highlighted");
        setTimeout(() => target.classList.remove("is-highlighted"), 2500);
      }
    } else if (scrollToDetail && window.matchMedia("(max-width: 700px)").matches) {
      elements.detailColumn.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (error) {
    if (state.detailRequestId === requestId) elements.videoDetail.replaceChildren(node("div", "detail-body detail-message", `读取失败：${error.message}`));
  } finally {
    if (state.detailRequestId === requestId) state.loadingDetail = false;
  }
}

function renderDetail() {
  const video = state.selectedVideo;
  if (!video) return;
  const points = Array.isArray(video.points) ? video.points : [];
  const body = node("div", "detail-body");
  const top = node("div", "detail-top");
  const titleArea = node("div");
  titleArea.append(node("p", "detail-kicker", "VIDEO NOTES"), node("h2", "", video.title || "未命名视频"));
  const actions = node("div", "detail-actions");
  const source = videoUrl(video.url);
  if (source) {
    const open = node("a", "detail-action", "打开视频 ↗");
    open.href = source.href;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    actions.append(open);
  }
  const exportButton = node("button", "detail-action", "导出 Markdown");
  exportButton.type = "button";
  exportButton.addEventListener("click", () => exportMarkdown(video));
  actions.append(exportButton);
  const remove = node("button", "detail-action is-danger", "删除");
  remove.type = "button";
  remove.addEventListener("click", () => deleteVideo(video));
  actions.append(remove);
  top.append(titleArea, actions);
  body.append(top);
  const meta = node("div", "detail-meta");
  const duration = Number(video.duration);
  if (Number.isFinite(duration) && duration > 0) meta.append(node("span", "", `时长 ${formatTime(duration)}`));
  meta.append(node("span", "", `${points.length} 个知识点`));
  if (video.source === "bilibili_course_summary") meta.append(node("span", "", "来源：B站课程总结"));
  const date = formatDate(video.created_at || video.updated_at);
  if (date) meta.append(node("span", "", date));
  body.append(meta);
  if (video.overview) {
    const overview = node("div", "overview");
    overview.append(node("p", "section-label", "内容概览"), node("p", "", video.overview));
    body.append(overview);
  }
  const toolbar = node("div", "point-toolbar");
  const heading = node("h3", "", "知识点 ");
  heading.append(node("span", "point-count", String(points.length)));
  toolbar.append(heading);
  body.append(toolbar);
  if (!points.length) {
    body.append(node("div", "detail-message", "暂无知识点。"));
  } else {
    const categories = ["全部", ...new Set(points.map((point) => point.category || "未分类"))];
    if (!categories.includes(state.activeCategory)) state.activeCategory = "全部";
    const filters = node("div", "category-filters");
    for (const category of categories) {
      const filter = node("button", `filter-chip${category === state.activeCategory ? " is-active" : ""}`, category);
      filter.type = "button";
      filter.setAttribute("aria-pressed", String(category === state.activeCategory));
      filter.addEventListener("click", () => { state.activeCategory = category; renderDetail(); });
      filters.append(filter);
    }
    body.append(filters);
    const visible = state.activeCategory === "全部" ? points : points.filter((point) => (point.category || "未分类") === state.activeCategory);
    const grouped = new Map();
    for (const point of visible) {
      const category = point.category || "未分类";
      if (!grouped.has(category)) grouped.set(category, []);
      grouped.get(category).push(point);
    }
    for (const [category, entries] of grouped) {
      const group = node("section", "category-group");
      group.append(node("h4", "category-heading", category));
      for (const point of entries) group.append(renderPoint(point, video.url, true, video.source));
      body.append(group);
    }
  }
  elements.videoDetail.replaceChildren(body);
}

function renderPoint(point, rawUrl, editable = true, sourceType = "") {
  const row = node("article", "point-row");
  if (point.id) row.dataset.pointId = String(point.id);
  const seconds = Number(point.time_seconds);
  const label = formatTime(seconds);
  const url = timedUrl(rawUrl, seconds);
  const approximate = Boolean(point.timestamp_approximate);
  const time = url ? node("a", "timestamp", `${approximate ? "约 " : ""}${label}`) : node("span", "timestamp", `${approximate ? "约 " : ""}${label}`);
  if (url) {
    time.href = url;
    time.target = "_blank";
    time.rel = "noopener noreferrer";
    time.title = approximate ? `约 ${label}，由转写内容估算，可能有偏差` : `从 ${label} 打开视频`;
  } else if (approximate) {
    time.title = "时间由转写内容估算，可能有偏差";
  }
  const content = node("div");
  content.append(node("h4", "", point.title || "未命名知识点"));
  if (point.explanation) content.append(node("p", "", point.explanation));
  if (point.evidence) content.append(node("p", "point-evidence", `${evidenceLabel(sourceType)}：${point.evidence}`));
  if (editable && point.id) {
    const controls = node("div", "point-controls");
    const edit = node("button", "text-button", "编辑");
    edit.type = "button";
    edit.setAttribute("aria-label", `编辑知识点：${point.title || "未命名知识点"}`);
    edit.addEventListener("click", () => openPointEditor(content, point));
    const statusLabel = node("label", "review-control");
    statusLabel.append(node("span", "", "核对状态"));
    const status = node("select");
    status.setAttribute("aria-label", `核对状态：${point.title || "未命名知识点"}`);
    for (const [value, label] of [["unreviewed", "未核对"], ["needs_review", "待核对"], ["reviewed", "已核对"]]) {
      const option = node("option", "", label);
      option.value = value;
      status.append(option);
    }
    status.value = point.review_status || "unreviewed";
    const statusMessage = node("span", "point-status-message");
    status.addEventListener("change", async () => {
      const previous = point.review_status || "unreviewed";
      status.disabled = true;
      statusMessage.textContent = "保存中…";
      try {
        const updated = await patchPoint(point, { review_status: status.value });
        Object.assign(point, updated);
        statusMessage.textContent = "已保存";
      } catch (error) {
        status.value = previous;
        statusMessage.textContent = error.message;
      } finally {
        status.disabled = false;
      }
    });
    statusLabel.append(status);
    controls.append(edit, statusLabel, statusMessage);
    content.append(controls);
  }
  row.append(time, content);
  return row;
}

async function patchPoint(point, changes) {
  const result = await request(
    `/api/videos/${encodeURIComponent(videoId(state.selectedVideo))}/points/${encodeURIComponent(point.id)}`,
    { method: "PATCH", body: JSON.stringify(changes) },
  );
  if (!result?.point) throw new Error("服务未返回更新后的知识点。");
  if (elements.videoSearch.value.trim()) await searchLibrary();
  return result.point;
}

function openPointEditor(content, point) {
  const form = node("form", "point-edit-form");
  const fields = [
    ["title", "标题", "text", 100],
    ["explanation", "解释", "textarea", 500],
    ["category", "分类", "text", 40],
  ];
  const inputs = {};
  for (const [name, labelText, kind, limit] of fields) {
    const label = node("label", "", labelText);
    const input = node(kind);
    input.name = name;
    input.value = point[name] || "";
    input.maxLength = limit;
    input.required = true;
    label.append(input);
    form.append(label);
    inputs[name] = input;
  }
  const error = node("p", "form-error");
  error.setAttribute("role", "alert");
  const actions = node("div", "point-edit-actions");
  const save = node("button", "button button-primary", "保存");
  save.type = "submit";
  const cancel = node("button", "button button-subtle", "取消");
  cancel.type = "button";
  cancel.addEventListener("click", () => { form.replaceWith(content); content.querySelector("button")?.focus(); });
  actions.append(save, cancel);
  form.append(error, actions);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const changes = Object.fromEntries(Object.entries(inputs).map(([name, input]) => [name, input.value.trim()]));
    if (Object.values(changes).some((value) => !value)) {
      error.textContent = "标题、解释和分类均不能为空。";
      return;
    }
    save.disabled = true;
    error.textContent = "";
    try {
      const updated = await patchPoint(point, changes);
      Object.assign(point, updated);
      renderDetail();
      const revised = [...elements.videoDetail.querySelectorAll("[data-point-id]")]
        .find((item) => item.dataset.pointId === String(point.id));
      revised?.querySelector(".point-controls button")?.focus();
      loadVideos(null, false);
    } catch (failure) {
      error.textContent = failure.message;
      save.disabled = false;
    }
  });
  content.replaceWith(form);
  inputs.title.focus();
}

function markdownText(value) {
  return String(value || "").replace(/([\\`*_{}\[\]()#+.!|>])/g, "\\$1");
}

function exportMarkdown(video) {
  const lines = [`# ${markdownText(video.title || "未命名视频")}`, ""];
  const source = videoUrl(video.url);
  if (source) lines.push(`视频：${source.href}`, "");
  if (video.source === "bilibili_course_summary") lines.push("来源：B站课程总结", "");
  if (video.overview) lines.push("## 内容概览", "", String(video.overview), "");
  const grouped = new Map();
  for (const point of video.points || []) {
    const category = point.category || "未分类";
    if (!grouped.has(category)) grouped.set(category, []);
    grouped.get(category).push(point);
  }
  for (const [category, points] of grouped) {
    lines.push(`## ${markdownText(category)}`, "");
    for (const point of points) {
      const label = formatTime(point.time_seconds);
      const link = timedUrl(video.url, point.time_seconds);
      const time = `${point.timestamp_approximate ? "约 " : ""}${label}`;
      lines.push(`### ${markdownText(point.title || "未命名知识点")}`, "");
      lines.push(link ? `时间：[${time}](${link})` : `时间：${time}`);
      lines.push(`核对状态：${({ unreviewed: "未核对", needs_review: "待核对", reviewed: "已核对" })[point.review_status] || "未核对"}`, "");
      if (point.explanation) lines.push(String(point.explanation), "");
      if (point.evidence) lines.push(`${evidenceLabel(video.source)}：`, "", ...String(point.evidence).split("\n").map((part) => `> ${part}`), "");
    }
  }
  const filename = (video.title || "视频知识点").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").slice(0, 80) || "视频知识点";
  const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = node("a");
  anchor.href = url;
  anchor.download = `${filename}.md`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function deleteVideo(video) {
  if (!confirm(`确定删除“${video.title || "此视频"}”及其知识点吗？`)) return;
  try {
    await request(`/api/videos/${encodeURIComponent(videoId(video))}`, { method: "DELETE" });
    state.selectedId = null;
    state.selectedVideo = null;
    await loadVideos();
    if (elements.videoSearch.value.trim()) await searchLibrary();
  } catch (error) {
    alert(`删除失败：${error.message}`);
  }
}

function showJob(kind, title, progress, dismissable = false) {
  elements.jobPanel.hidden = false;
  elements.jobPanel.className = `job-panel${kind ? ` is-${kind}` : ""}`;
  elements.jobIcon.textContent = kind === "error" ? "!" : kind === "done" ? "✓" : "◌";
  elements.jobTitle.textContent = title;
  elements.jobProgress.textContent = progress;
  elements.dismissJob.hidden = !dismissable;
  elements.cancelJob.hidden = !state.jobId || !state.jobLeaseId;
  elements.confirmTranscription.hidden = true;
}

function finishJob() {
  state.jobId = null;
  state.jobLeaseId = null;
  state.jobUrl = null;
  try { localStorage.removeItem("video-knowledge-job-id"); } catch { /* Storage may be disabled. */ }
  if (state.jobTimer) clearTimeout(state.jobTimer);
  state.jobTimer = null;
  elements.analyzeButton.disabled = false;
  elements.cancelJob.hidden = true;
}

function renderPartial(job) {
  const points = Array.isArray(job.partial_points) ? job.partial_points : [];
  const overview = typeof job.partial_overview === "string" ? job.partial_overview : "";
  const signature = JSON.stringify([overview, points]);
  if (signature === state.partialSignature) return;
  state.partialSignature = signature;
  elements.partialPanel.hidden = !points.length && !overview;
  if (elements.partialPanel.hidden) {
    elements.partialPanel.replaceChildren();
    return;
  }
  const heading = node("div", "partial-heading");
  heading.append(node("h2", "", "已提取的内容"), node("span", "partial-badge", "处理中 · 尚未保存"));
  const fragment = document.createDocumentFragment();
  fragment.append(heading);
  if (overview) fragment.append(node("p", "partial-overview", overview));
  for (const point of points) fragment.append(renderPoint(point, state.jobUrl, false));
  elements.partialPanel.replaceChildren(fragment);
}

function clearPartial() {
  state.partialSignature = "";
  elements.partialPanel.hidden = true;
  elements.partialPanel.replaceChildren();
}

async function pollJob() {
  if (!state.jobId) return;
  const jobId = state.jobId;
  try {
    const job = await request(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (state.jobId !== jobId) return;
    const status = String(job.status || "").toLowerCase();
    if (["done", "completed", "succeeded", "success"].includes(status)) {
      finishJob();
      clearPartial();
      showJob("done", "整理完成", "知识点已保存到知识库。", true);
      const resultId = job.result?.id || job.result?.video_id || job.result?.video?.id;
      await loadVideos(resultId ? String(resultId) : null);
      return;
    }
    if (["error", "failed", "failure"].includes(status)) {
      const retryUrl = state.jobUrl;
      finishJob();
      clearPartial();
      if (job.error_code === "transcription_required" && retryUrl) {
        state.pendingTranscriptionUrl = retryUrl;
        const duration = Number(job.duration_seconds);
        const length = Number.isFinite(duration) && duration > 0 ? `（时长 ${formatTime(duration)}）` : "";
        showJob("error", "没有可用字幕", `该视频${length}需要调用语音转写，可能产生费用。确认后继续。`, true);
        elements.confirmTranscription.hidden = false;
      } else {
        showJob("error", "整理失败", errorText(job.error), true);
      }
      return;
    }
    if (status === "cancelled") {
      finishJob();
      clearPartial();
      showJob("done", "已停止整理", "当前任务已取消。", true);
      return;
    }
    const progress = typeof job.progress === "string" ? job.progress :
      (Number.isFinite(Number(job.progress)) ? `${Math.round(Number(job.progress))}%` : "正在处理，请稍候…");
    showJob("", status === "summarizing" ? "正在提炼知识点" : "正在整理视频", progress);
    renderPartial(job);
    state.jobTimer = setTimeout(pollJob, 2000);
  } catch (error) {
    if (error.status === 404) {
      finishJob();
      clearPartial();
      showJob("error", "任务已失效", "服务已重启或任务记录已清理，请重新提交视频。", true);
    } else if (state.jobId === jobId) {
      showJob("error", "暂时无法获取进度", `${error.message} 5 秒后重试。`);
      state.jobTimer = setTimeout(pollJob, 5000);
    }
  }
}

async function startAnalysis(url, allowTranscription = false) {
  if (state.jobId) {
    showFormError("当前有视频正在整理，请稍候。");
    return;
  }
  state.pendingTranscriptionUrl = null;
  clearPartial();
  elements.analyzeButton.disabled = true;
  showJob("", "正在提交视频", "准备中…");
  try {
    const result = await request("/api/analyze", {
      method: "POST",
      body: JSON.stringify({ url, allow_transcription: allowTranscription }),
    });
    if (!result?.job_id) throw new Error("服务未返回任务编号。");
    state.jobId = String(result.job_id);
    state.jobLeaseId = result.lease_id || null;
    state.jobUrl = url;
    try {
      localStorage.setItem("video-knowledge-job-id", JSON.stringify({ id: state.jobId, leaseId: state.jobLeaseId, url }));
    } catch { /* Polling still works in this tab. */ }
    $("#video-url").value = "";
    pollJob();
  } catch (error) {
    elements.analyzeButton.disabled = false;
    showJob("error", "提交失败", error.message, true);
    if (allowTranscription) {
      state.pendingTranscriptionUrl = url;
      elements.confirmTranscription.hidden = false;
    }
  }
}

async function submitVideo(event) {
  event.preventDefault();
  showFormError("");
  const url = $("#video-url").value.trim();
  if (!videoUrl(url)) {
    showFormError("请填写有效的哔哩哔哩视频链接。");
    return;
  }
  await startAnalysis(url);
}

async function cancelAnalysis() {
  const jobId = state.jobId;
  const leaseId = state.jobLeaseId;
  if (!jobId || !leaseId) return;
  elements.cancelJob.disabled = true;
  if (state.jobTimer) clearTimeout(state.jobTimer);
  state.jobTimer = null;
  try {
    const result = await request(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
      method: "POST",
      body: JSON.stringify({ lease_id: leaseId }),
    });
    if (!result?.released) {
      await pollJob();
      return;
    }
    finishJob();
    clearPartial();
    showJob("done", "已停止关注", result?.remaining_subscribers ? "其他页面仍在整理这个视频。" : "整理已停止。", true);
  } catch (error) {
    showJob("error", "停止失败", error.message);
    if (state.jobId === jobId) state.jobTimer = setTimeout(pollJob, 2000);
  } finally {
    elements.cancelJob.disabled = false;
  }
}

async function loadSettings() {
  showSettingsError("");
  try {
    const data = await request("/api/settings");
    $("#setting-base-url").value = data?.base_url || "";
    $("#setting-model").value = data?.model || "";
    $("#setting-transcription-model").value = data?.transcription_model || "";
    $("#setting-api-key").value = "";
    elements.keyState.textContent = data?.has_api_key ? "（已保存）" : "（未设置）";
  } catch (error) {
    showSettingsError(error.message);
  }
}

async function saveSettings(event) {
  event.preventDefault();
  showSettingsError("");
  elements.settingsSaved.textContent = "";
  const data = {
    base_url: $("#setting-base-url").value.trim(),
    model: $("#setting-model").value.trim(),
    transcription_model: $("#setting-transcription-model").value.trim(),
  };
  const key = $("#setting-api-key").value.trim();
  if (key) data.api_key = key;
  elements.saveSettings.disabled = true;
  try {
    await request("/api/settings", { method: "POST", body: JSON.stringify(data) });
    $("#setting-api-key").value = "";
    elements.settingsSaved.textContent = "已保存";
    await Promise.all([loadSettings(), loadStatus()]);
  } catch (error) {
    showSettingsError(error.message);
  } finally {
    elements.saveSettings.disabled = false;
  }
}

function resumeJob() {
  try {
    const previousJob = localStorage.getItem("video-knowledge-job-id");
    if (!previousJob) return;
    let saved;
    try { saved = JSON.parse(previousJob); } catch { saved = { id: previousJob }; }
    state.jobId = typeof saved === "string" ? saved : saved?.id;
    state.jobLeaseId = typeof saved === "object" ? saved?.leaseId || null : null;
    state.jobUrl = typeof saved === "object" ? saved?.url || null : null;
    elements.analyzeButton.disabled = true;
    showJob("", "正在恢复任务", "正在检查进度…");
    if (state.jobId) pollJob();
  } catch { /* Private browsing can disable localStorage. */ }
}

function openApp(status) {
  applyStatus(status);
  state.authenticated = true;
  elements.bootView.hidden = true;
  elements.authView.hidden = true;
  elements.appShell.hidden = false;
  elements.signoutButton.hidden = !state.accessToken;
  setView(location.hash === "#settings" ? "settings" : "library");
  loadVideos();
  resumeJob();
}

async function bootstrap() {
  elements.authView.hidden = true;
  elements.appShell.hidden = true;
  elements.bootView.hidden = false;
  elements.bootMessage.textContent = "正在连接服务…";
  elements.retryConnection.hidden = true;
  try {
    openApp(await request("/api/status"));
  } catch (error) {
    if (error.status === 401) return;
    elements.bootMessage.textContent = error.message;
    elements.retryConnection.hidden = false;
  }
}

async function submitAccessToken(event) {
  event.preventDefault();
  const token = $("#access-token").value.trim();
  if (!token) return;
  elements.authError.hidden = true;
  elements.authSubmit.disabled = true;
  try {
    const status = await request("/api/status", { accessToken: token, suppressAuthLock: true });
    state.accessToken = token;
    try {
      sessionStorage.setItem(ACCESS_TOKEN_KEY, token);
      window.location.reload();
    } catch {
      openApp(status);
    }
  } catch (error) {
    elements.authError.textContent = error.status === 401 ? "访问令牌无效，请重试。" : error.message;
    elements.authError.hidden = false;
  } finally {
    elements.authSubmit.disabled = false;
  }
}

function signOut() {
  state.accessToken = "";
  try { sessionStorage.removeItem(ACCESS_TOKEN_KEY); } catch { /* Storage may be disabled. */ }
  elements.appShell.hidden = true;
  window.location.reload();
}

document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => navigate(button.dataset.view)));
document.querySelectorAll("[data-open-settings]").forEach((button) => button.addEventListener("click", () => navigate("settings")));
window.addEventListener("hashchange", () => setView(location.hash === "#settings" ? "settings" : "library"));
elements.authForm.addEventListener("submit", submitAccessToken);
elements.retryConnection.addEventListener("click", bootstrap);
elements.signoutButton.addEventListener("click", signOut);
elements.videoSearch.addEventListener("input", () => {
  if (state.searchTimer) clearTimeout(state.searchTimer);
  ++state.searchRequestId;
  state.searchResults = [];
  state.searchError = "";
  state.searchPending = Boolean(elements.videoSearch.value.trim());
  renderVideoList();
  if (!state.searchPending) searchLibrary();
  else state.searchTimer = setTimeout(searchLibrary, 250);
});
elements.analyzeForm.addEventListener("submit", submitVideo);
elements.settingsForm.addEventListener("submit", saveSettings);
elements.dismissJob.addEventListener("click", () => { elements.jobPanel.hidden = true; });
elements.cancelJob.addEventListener("click", cancelAnalysis);
elements.confirmTranscription.addEventListener("click", () => {
  if (state.pendingTranscriptionUrl) startAnalysis(state.pendingTranscriptionUrl, true);
});
$("#refresh-button").addEventListener("click", () => { loadStatus(); loadVideos(); if (location.hash === "#settings") loadSettings(); });
setInterval(() => {
  if (state.authenticated && !document.hidden && location.hash !== "#settings" && !state.loadingDetail) loadVideos(null, false);
}, 15000);

bootstrap();
