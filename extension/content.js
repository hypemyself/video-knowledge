(() => {
  const PANEL_ID = "zhidian-video-panel";
  if (document.getElementById(PANEL_ID)) return;

  const host = document.createElement("div");
  host.id = PANEL_ID;
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: "open" });
  const stylesheet = document.createElement("link");
  stylesheet.rel = "stylesheet";
  stylesheet.href = chrome.runtime.getURL("panel.css");
  shadow.appendChild(stylesheet);

  const shell = document.createElement("section");
  shell.className = "zk-shell";
  shell.setAttribute("aria-label", "视频知识整理");
  shell.innerHTML = `
    <button class="zk-reopen" type="button" title="打开知识点侧栏" aria-label="打开知识点侧栏">知识点</button>
    <div class="zk-panel">
      <header class="zk-header">
        <div class="zk-brand"><span class="zk-mark">知</span><span>知点</span><span class="zk-brand-sub">视频知识整理</span></div>
        <div class="zk-header-actions">
          <button class="zk-icon-button zk-options" type="button" title="连接设置" aria-label="连接设置">⚙</button>
          <button class="zk-icon-button zk-dashboard" type="button" title="打开整理记录" aria-label="打开整理记录">↗</button>
          <button class="zk-icon-button zk-toggle" type="button" title="收起侧栏" aria-label="收起侧栏">×</button>
        </div>
      </header>
      <div class="zk-video-line"><span class="zk-video-label">当前视频</span><strong class="zk-video-title"></strong></div>
      <div class="zk-task-bar">
        <label class="zk-auto-label"><input class="zk-auto" type="checkbox" checked><span>自动整理</span></label>
        <div class="zk-task-actions">
          <button class="zk-task-button zk-skip" type="button" hidden>本次跳过</button>
          <button class="zk-task-button zk-start" type="button" hidden>开始整理</button>
          <button class="zk-task-button zk-cancel" type="button" hidden>停止整理</button>
        </div>
      </div>
      <div class="zk-body" aria-live="polite"></div>
      <footer class="zk-footer"><span class="zk-footer-text">跳转时间点可回看对应片段</span><button class="zk-retry" type="button" title="重新整理当前视频">重新整理</button></footer>
    </div>`;
  shadow.appendChild(shell);

  const body = shell.querySelector(".zk-body");
  const title = shell.querySelector(".zk-video-title");
  const footerText = shell.querySelector(".zk-footer-text");
  const retryButton = shell.querySelector(".zk-retry");
  const openButton = shell.querySelector(".zk-reopen");
  const toggleButton = shell.querySelector(".zk-toggle");
  const dashboardButton = shell.querySelector(".zk-dashboard");
  const optionsButton = shell.querySelector(".zk-options");
  const autoCheckbox = shell.querySelector(".zk-auto");
  const skipButton = shell.querySelector(".zk-skip");
  const startButton = shell.querySelector(".zk-start");
  const cancelButton = shell.querySelector(".zk-cancel");

  let pageKey = "";
  let currentRun = 0;
  let isCollapsed = true;
  let autoAnalyze = true;
  let preferencesLoaded = false;
  let skippedCurrentVideo = false;
  let waitingToStart = false;
  let isRunning = false;
  let pageOutcome = false;
  let activeJobId = null;
  let activeLeaseId = null;
  let nextAttemptAt = 0;
  let lastPartialFingerprint = "";
  let summaryImportRequiresReload = false;
  let durationPage = "";
  let observedDuration = NaN;
  let durationChecks = 0;

  chrome.storage.local.get(["zkCollapsed", "zkAutoAnalyze"], (values) => {
    isCollapsed = values.zkCollapsed !== false;
    shell.classList.toggle("zk-collapsed", isCollapsed);
    autoAnalyze = values.zkAutoAnalyze !== false;
    autoCheckbox.checked = autoAnalyze;
    preferencesLoaded = true;
    if (pageKey && !isRunning && !pageOutcome) showWaiting();
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes.zkAutoAnalyze) return;
    autoAnalyze = changes.zkAutoAnalyze.newValue !== false;
    autoCheckbox.checked = autoAnalyze;
    if (pageKey && !isRunning && !pageOutcome) showWaiting();
  });

  openButton.addEventListener("click", () => setCollapsed(false));
  toggleButton.addEventListener("click", () => setCollapsed(true));
  dashboardButton.addEventListener("click", () => chrome.runtime.sendMessage({ kind: "open-dashboard" }));
  optionsButton.addEventListener("click", () => chrome.runtime.sendMessage({ kind: "open-options" }));
  retryButton.addEventListener("click", () => startAnalysis({ force: true }));
  autoCheckbox.addEventListener("change", () => {
    autoAnalyze = autoCheckbox.checked;
    chrome.storage.local.set({ zkAutoAnalyze: autoAnalyze });
    if (pageKey && !isRunning && !pageOutcome) showWaiting();
  });
  skipButton.addEventListener("click", () => {
    skippedCurrentVideo = true;
    waitingToStart = false;
    showWaiting();
  });
  startButton.addEventListener("click", () => startAnalysis());
  cancelButton.addEventListener("click", () => {
    currentRun += 1;
    waitingToStart = false;
    isRunning = false;
    pageOutcome = true;
    cancelActiveJob();
    updateActions();
    showStatus("已停止整理", "可以随时重新整理当前视频。");
    retryButton.disabled = false;
  });

  function setCollapsed(value) {
    isCollapsed = value;
    shell.classList.toggle("zk-collapsed", value);
    chrome.storage.local.set({ zkCollapsed: value });
  }

  function request(method, path, data) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ kind: "api", method, path, body: data }, (response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error("扩展连接中断，请刷新页面后重试。"));
        } else if (!response?.ok) {
          const error = new Error(response?.error || "请求失败。");
          error.status = response?.status;
          reject(error);
        } else {
          resolve(response.data);
        }
      });
    });
  }

  function videoIdentity() {
    const match = location.pathname.match(/^\/video\/(BV[0-9A-Za-z]{10})/i);
    if (!match) return null;
    const page = Math.max(1, Number(new URL(location.href).searchParams.get("p")) || 1);
    return { bvid: match[1], page, key: `${match[1]}:${page}` };
  }

  function getVideoTitle() {
    const heading = document.querySelector("h1.video-title, h1[title], .video-title h1");
    return heading?.getAttribute("title") || heading?.textContent?.trim() || document.title.replace(/_哔哩哔哩.*$/, "").trim() || "未命名视频";
  }

  function clearBody() {
    body.replaceChildren();
  }

  function make(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = value;
    return element;
  }

  function showStatus(heading, message, progress) {
    clearBody();
    const box = make("div", "zk-state");
    box.appendChild(make("div", "zk-state-mark", progress === undefined ? "!" : "···"));
    box.appendChild(make("h2", "zk-state-title", heading));
    box.appendChild(make("p", "zk-state-copy", message));
    if (progress !== undefined) {
      const track = make("div", "zk-progress-track");
      const fill = make("div", "zk-progress-fill");
      fill.style.width = `${Math.max(0, Math.min(100, Number(progress) || 0))}%`;
      track.appendChild(fill);
      box.appendChild(track);
    }
    body.appendChild(box);
    footerText.textContent = progress === undefined ? "打开知点可检查设置" : "处理时间取决于视频长度";
  }

  function updateActions() {
    skipButton.hidden = isRunning || !waitingToStart || !autoAnalyze || skippedCurrentVideo;
    startButton.hidden = isRunning || pageOutcome || (waitingToStart && autoAnalyze && !skippedCurrentVideo);
    cancelButton.hidden = !isRunning;
  }

  function showWaiting() {
    waitingToStart = !skippedCurrentVideo && autoAnalyze;
    nextAttemptAt = 0;
    updateActions();
    if (skippedCurrentVideo) {
      showStatus("已跳过当前视频", "需要时可以手动开始整理。");
    } else if (!autoAnalyze) {
      showStatus("自动整理已关闭", "点击开始整理当前视频。");
    } else {
      showStatus("等待播放", "视频播放数秒后自动整理。", 0);
    }
  }

  function formatTime(seconds) {
    const value = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const remainder = String(value % 60).padStart(2, "0");
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${remainder}` : `${minutes}:${remainder}`;
  }

  function mainPlayer() {
    const videos = [...document.querySelectorAll(".bpx-player-video-wrap video, #bilibili-player video, video")];
    const candidates = [...new Set(videos)]
      .map((video) => ({ video, area: video.getBoundingClientRect().width * video.getBoundingClientRect().height }))
      .filter(({ video, area }) => video.isConnected && area > 25000)
      .sort((a, b) => b.area - a.area);
    return candidates[0]?.video;
  }

  function seek(seconds) {
    const player = mainPlayer();
    if (!player || !Number.isFinite(seconds)) {
      footerText.textContent = "播放器暂未准备好，请稍后重试";
      return;
    }
    try {
      player.currentTime = Math.max(0, seconds);
    } catch {
      footerText.textContent = "暂时无法跳转，请稍后重试";
    }
  }

  function renderResult(result, { partial = false, progress = 0 } = {}) {
    const scrollTop = body.scrollTop;
    const selectedCategory = body.querySelector(".zk-filter")?.value;
    clearBody();
    const points = Array.isArray(result.points) ? result.points : [];
    if (partial) {
      const status = make("div", "zk-partial-status", `整理中 · ${Math.max(0, Math.min(100, Number(progress) || 0))}%`);
      status.setAttribute("role", "status");
      body.appendChild(status);
    }
    const overview = make("section", "zk-overview");
    overview.appendChild(make("div", "zk-section-label", "视频概览"));
    overview.appendChild(make("p", "zk-overview-copy", result.overview || (partial ? "正在提炼视频内容。" : "已整理当前视频的主要知识点。")));
    body.appendChild(overview);

    const controls = make("div", "zk-controls");
    const count = make("span", "zk-count", `${points.length} 个知识点`);
    const filter = make("select", "zk-filter");
    filter.setAttribute("aria-label", "按分类筛选知识点");
    const categories = ["全部分类", ...new Set(points.map((point) => point.category || "其他"))];
    for (const category of categories) {
      const option = make("option", "", category);
      option.value = category;
      filter.appendChild(option);
    }
    if (selectedCategory && categories.includes(selectedCategory)) filter.value = selectedCategory;
    controls.append(count, filter);
    body.appendChild(controls);

    const list = make("div", "zk-list");
    const renderList = () => {
      list.replaceChildren();
      const visible = points.filter((point) => filter.value === "全部分类" || (point.category || "其他") === filter.value);
      for (const point of visible) {
        const item = make("article", "zk-point");
        const meta = make("div", "zk-point-meta");
        meta.appendChild(make("span", "zk-category", point.category || "其他"));
        const timeLabel = `${point.timestamp_approximate ? "约 " : ""}${formatTime(point.time_seconds)}`;
        const jump = make("button", "zk-time", timeLabel);
        jump.type = "button";
        jump.title = point.timestamp_approximate
          ? `转写服务未提供精确时间；跳转到约 ${formatTime(point.time_seconds)}`
          : `跳转到 ${formatTime(point.time_seconds)}`;
        jump.addEventListener("click", () => seek(Number(point.time_seconds)));
        meta.appendChild(jump);
        item.appendChild(meta);
        item.appendChild(make("h3", "zk-point-title", point.title || "知识点"));
        item.appendChild(make("p", "zk-point-explanation", point.explanation || ""));
        if (point.evidence) {
          item.appendChild(make("blockquote", "zk-evidence", point.evidence));
        }
        list.appendChild(item);
      }
      if (!visible.length) list.appendChild(make("p", "zk-empty", "这个分类暂无知识点。"));
    };
    filter.addEventListener("change", renderList);
    renderList();
    body.appendChild(list);
    body.scrollTop = scrollTop;
    footerText.textContent = partial ? "知识点持续更新中" : (
      result.source === "bilibili_course_summary" ? "B站课程总结整理 · 点击时间点回看" :
      result.source === "transcription" ? "音频转写整理 · 点击时间点回看" : "字幕整理 · 点击时间点回看"
    );
  }

  function courseSummaryPayload() {
    const identity = videoIdentity();
    if (summaryImportRequiresReload) return null;
    const summary = window.ZhiDianCourseSummary?.extract(document);
    if (!identity || !summary) return null;
    const duration = Number(mainPlayer()?.duration);
    if (durationPage !== identity.key || durationChecks < 2 || !Number.isFinite(duration) || duration <= 0 ||
        !Number.isFinite(summary.end_seconds) || Math.abs(duration - summary.end_seconds) > 30) return null;
    const url = new URL(`/video/${identity.bvid}/`, "https://www.bilibili.com");
    if (identity.page > 1) url.searchParams.set("p", String(identity.page));
    return { url: url.href, overview: summary.overview, points: summary.points };
  }

  function offerCourseSummaryImport() {
    const box = body.querySelector(".zk-state");
    if (!box || box.querySelector(".zk-import-summary")) return;
    const button = make("button", "zk-import-summary", "导入B站课程总结");
    button.type = "button";
    button.addEventListener("click", importCourseSummary);
    box.appendChild(button);
  }

  async function importCourseSummary() {
    const payload = courseSummaryPayload();
    if (!payload) {
      const message = summaryImportRequiresReload
        ? "切换分 P 后请刷新视频页，再打开当前分 P 的课程总结。"
        : "请在 B 站打开当前分 P 的完整课程总结，等待播放器和章节加载后重试。";
      showStatus("无法导入B站课程总结", `${message} 如需 AI 整理，请点下方“重新整理”；没有字幕时需选择“转写音频”。`);
      offerCourseSummaryImport();
      return;
    }
    currentRun += 1;
    cancelActiveJob();
    const runId = currentRun;
    waitingToStart = false;
    isRunning = true;
    pageOutcome = false;
    updateActions();
    retryButton.disabled = true;
    showStatus("正在导入课程总结", "正在保存当前视频显示的章节和时间点。", 30);
    try {
      const response = await request("POST", "/api/import-course-summary", payload);
      if (runId !== currentRun) return;
      pageOutcome = true;
      renderResult(response.result || {});
    } catch (error) {
      if (runId === currentRun) {
        pageOutcome = true;
        showStatus("导入未完成", error.message || "请稍后重试。");
        offerCourseSummaryImport();
      }
    } finally {
      if (runId === currentRun) {
        isRunning = false;
        updateActions();
        retryButton.disabled = false;
      }
    }
  }

  function showTranscriptionChoice(job) {
    const duration = Number(job.duration_seconds);
    const time = Number.isFinite(duration) && duration > 0 ? `视频时长约 ${formatTime(duration)}。` : "";
    showStatus("没有可用字幕", `${time}转写音频可能产生 AI 服务费用。`);
    const button = make("button", "zk-confirm-transcription", "转写音频");
    button.type = "button";
    button.addEventListener("click", () => startAnalysis({ allowTranscription: true }));
    body.querySelector(".zk-state").appendChild(button);
    footerText.textContent = "确认后才会发送音频进行转写";
    offerCourseSummaryImport();
  }

  const progressText = {
    queued: "准备整理视频",
    fetching: "正在读取视频和字幕",
    transcribing: "正在转写视频音频",
    summarizing: "正在提炼和分类知识点",
  };

  async function pollJob(jobId, runId) {
    while (runId === currentRun) {
      const job = await request("GET", `/api/jobs/${encodeURIComponent(jobId)}`);
      if (runId !== currentRun) return;
      if (job.status === "done") {
        pageOutcome = true;
        renderResult(job.result || {});
        return;
      }
      if (job.status === "error") {
        pageOutcome = true;
        if (job.error_code === "transcription_required") {
          showTranscriptionChoice(job);
          return;
        }
        throw new Error(job.error || "整理失败，请稍后重试。");
      }
      if (job.status === "cancelled") {
        pageOutcome = true;
        throw new Error("整理已取消。");
      }
      const partialPoints = Array.isArray(job.partial_points) ? job.partial_points : [];
      if (job.status === "summarizing" && (partialPoints.length || job.partial_overview)) {
        const fingerprint = JSON.stringify([job.partial_overview, partialPoints, job.progress]);
        if (fingerprint !== lastPartialFingerprint) {
          renderResult({ overview: job.partial_overview, points: partialPoints }, { partial: true, progress: job.progress });
          lastPartialFingerprint = fingerprint;
        }
      } else {
        showStatus(progressText[job.status] || "正在整理视频", "整理完成后，知识点会自动出现在这里。", job.progress || 0);
      }
      await new Promise((resolve) => setTimeout(resolve, 1600));
    }
  }

  async function startAnalysis({ force = false, allowTranscription = false, auto = false } = {}) {
    const identity = videoIdentity();
    if (!identity) return;
    currentRun += 1;
    cancelActiveJob();
    pageKey = identity.key;
    waitingToStart = false;
    nextAttemptAt = 0;
    isRunning = true;
    pageOutcome = false;
    lastPartialFingerprint = "";
    const runId = currentRun;
    updateActions();
    title.textContent = getVideoTitle();
    showStatus("正在连接知点服务", "正在检查整理设置。", 4);
    retryButton.disabled = true;
    try {
      const status = await request("GET", "/api/status");
      if (runId !== currentRun) return;
      if (!status.configured) {
        pageOutcome = true;
        const videoId = `${identity.bvid}-p${identity.page}`;
        try {
          const cached = await request("GET", `/api/videos/${videoId}`);
          if (runId !== currentRun) return;
          renderResult(cached);
        } catch (error) {
          if (runId !== currentRun) return;
          if (error.status !== 404) throw error;
          showStatus("请先配置 AI 服务", "在知点网页填写 API 密钥，或导入 B 站已有的课程总结。");
          offerCourseSummaryImport();
        }
        return;
      }
      showStatus("开始整理视频", "正在读取视频字幕。", 8);
      const url = new URL(`/video/${identity.bvid}/`, "https://www.bilibili.com");
      if (identity.page > 1) url.searchParams.set("p", String(identity.page));
      const response = await request("POST", "/api/analyze", { url: url.href, title: title.textContent, force, allow_transcription: allowTranscription });
      if (runId !== currentRun) {
        if (response.lease_id) {
          request("POST", `/api/jobs/${encodeURIComponent(response.job_id)}/cancel`, { lease_id: response.lease_id }).catch(() => {});
        }
        return;
      }
      activeJobId = response.job_id;
      activeLeaseId = response.lease_id || null;
      await pollJob(response.job_id, runId);
    } catch (error) {
      if (runId === currentRun) {
        if (error.status === 429 && auto && !force && autoAnalyze && !skippedCurrentVideo) {
          waitingToStart = true;
          nextAttemptAt = Date.now() + 5000;
          showStatus("等待空闲", "其他视频仍在整理，稍后自动重试。", 0);
        } else {
          pageOutcome = true;
          showStatus("整理未完成", error.message || "请检查知点服务和视频访问情况。");
          if (/音频转文字服务|音频转写服务/.test(error.message || "")) offerCourseSummaryImport();
        }
      }
    } finally {
      if (runId === currentRun) {
        activeJobId = null;
        activeLeaseId = null;
        isRunning = false;
        updateActions();
        retryButton.disabled = false;
      }
    }
  }

  function cancelActiveJob() {
    if (!activeJobId || !activeLeaseId) return;
    const jobId = activeJobId;
    const leaseId = activeLeaseId;
    activeJobId = null;
    activeLeaseId = null;
    request("POST", `/api/jobs/${encodeURIComponent(jobId)}/cancel`, { lease_id: leaseId }).catch(() => {});
  }

  function checkNavigation() {
    const identity = videoIdentity();
    if (!identity) {
      if (pageKey) {
        summaryImportRequiresReload = true;
        currentRun += 1;
        cancelActiveJob();
        pageKey = "";
        waitingToStart = false;
        isRunning = false;
        skippedCurrentVideo = false;
        pageOutcome = false;
        retryButton.disabled = false;
        clearBody();
      }
      host.style.display = "none";
      return;
    }
    host.style.display = "";
    if (identity.key !== pageKey) {
      if (pageKey) summaryImportRequiresReload = true;
      currentRun += 1;
      cancelActiveJob();
      pageKey = identity.key;
      isRunning = false;
      skippedCurrentVideo = false;
      pageOutcome = false;
      title.textContent = getVideoTitle();
      retryButton.disabled = false;
      showWaiting();
    }
    const player = mainPlayer();
    const duration = Number(player?.duration);
    if (durationPage === identity.key && Number.isFinite(duration) && Math.abs(duration - observedDuration) < 0.5) {
      durationChecks += 1;
    } else {
      durationPage = identity.key;
      observedDuration = duration;
      durationChecks = Number.isFinite(duration) && duration > 0 ? 1 : 0;
    }
    if (preferencesLoaded && waitingToStart && autoAnalyze && Date.now() >= nextAttemptAt && player && !player.paused && player.currentTime >= 3) {
      startAnalysis({ auto: true });
    }
  }

  checkNavigation();
  setInterval(checkNavigation, 1200);
  window.addEventListener("pagehide", () => {
    currentRun += 1;
    waitingToStart = false;
    isRunning = false;
    cancelActiveJob();
  });
  window.addEventListener("pageshow", (event) => {
    if (event.persisted) {
      pageKey = "";
      checkNavigation();
    }
  });
})();
