import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("./content.js", import.meta.url), "utf8");

class Element {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.listeners = new Map();
    this.style = {};
    this.className = "";
    this.attributes = {};
    this.scrollTop = 0;
    this.hidden = false;
    this._text = "";
    this.classList = {
      contains: (name) => this.className.split(" ").includes(name),
      toggle: (name, enabled) => {
        const names = new Set(this.className.split(" ").filter(Boolean));
        if (enabled) names.add(name);
        else names.delete(name);
        this.className = [...names].join(" ");
      },
    };
  }

  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(""); }
  set innerHTML(value) {
    if (!value.includes("zk-reopen")) return;
    for (const className of [
      "zk-reopen", "zk-panel", "zk-brand", "zk-options", "zk-dashboard", "zk-toggle",
      "zk-video-title", "zk-auto", "zk-skip", "zk-start", "zk-cancel",
      "zk-body", "zk-footer-text", "zk-retry",
    ]) {
      const node = new Element(className === "zk-auto" ? "input" : "div");
      node.className = className;
      this.appendChild(node);
    }
  }
  appendChild(child) {
    this.children.push(child);
    if (this.tag === "select" && this.children.length === 1) this.value = child.value;
    return child;
  }
  append(...children) { children.forEach((child) => this.appendChild(child)); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  click() { this.listeners.get("click")?.({ target: this }); }
  change() { this.listeners.get("change")?.({ target: this }); }
  setAttribute(name, value) { this.attributes[name] = value; }
  getAttribute(name) { return this.attributes[name]; }
  querySelector(selector) {
    const className = selector.slice(1);
    for (const child of this.children) {
      if (child.className.split(" ").includes(className)) return child;
      const nested = child.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
  attachShadow() { this.shadowRoot = new Element("shadow"); return this.shadowRoot; }
}

function createHarness({ storage = {}, playerTime = 0, courseSummary = null, respond }) {
  let availableSummary = courseSummary;
  const local = { ...storage };
  const calls = [];
  const onChanged = [];
  let interval;
  let host;
  const player = {
    currentTime: playerTime,
    duration: 300,
    paused: false,
    isConnected: true,
    getBoundingClientRect: () => ({ width: 800, height: 450 }),
  };
  const document = {
    documentElement: { appendChild(node) { host = node; } },
    getElementById: () => host,
    createElement: (tag) => new Element(tag),
    querySelector: () => ({ getAttribute: () => "测试视频" }),
    querySelectorAll: () => [player],
    title: "测试视频",
  };
  const chrome = {
    runtime: {
      getURL: (name) => name,
      lastError: null,
      sendMessage(message, callback) {
        calls.push(message);
        if (!callback) return;
        Promise.resolve().then(() => respond(message)).then(
          (data) => callback({ ok: true, data }),
          (error) => callback({ ok: false, error: error.message, status: error.status }),
        );
      },
    },
    storage: {
      local: {
        get: (_keys, callback) => callback(local),
        set: (updates) => {
          for (const [key, value] of Object.entries(updates)) {
            const oldValue = local[key];
            local[key] = value;
            for (const listener of onChanged) listener({ [key]: { oldValue, newValue: value } }, "local");
          }
        },
      },
      onChanged: { addListener: (listener) => onChanged.push(listener) },
    },
  };
  const location = {
    pathname: "/video/BV1234567890/",
    href: "https://www.bilibili.com/video/BV1234567890/",
  };
  const window = {
    addEventListener() {}, open() {},
    ZhiDianCourseSummary: { extract: () => availableSummary },
  };
  runInNewContext(source, {
    chrome, document, location, window, URL,
    setInterval: (callback) => { interval = callback; },
    setTimeout: (callback) => setTimeout(callback, 1),
  });
  const shell = host.shadowRoot.querySelector(".zk-shell");
  return {
    calls,
    local,
    player,
    setCourseSummary: (value) => { availableSummary = value; },
    setPage: (page) => {
      location.pathname = "/video/BV1234567890/";
      location.href = `https://www.bilibili.com/video/BV1234567890/?p=${page}`;
    },
    leaveVideo: () => { location.pathname = "/"; location.href = "https://www.bilibili.com/"; },
    shell,
    tick: () => interval(),
    get: (selector) => shell.querySelector(selector),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("manual analysis requests captions first and asks before paid transcription", async () => {
  const harness = createHarness({
    storage: { zkCollapsed: false, zkAutoAnalyze: false },
    respond(message) {
      if (message.path === "/api/status") return { configured: true };
      if (message.path === "/api/analyze") {
        return { job_id: message.body.allow_transcription ? "with-audio" : "captions-only", lease_id: "lease" };
      }
      if (message.path === "/api/jobs/captions-only") {
        return { status: "error", error_code: "transcription_required", duration_seconds: 302 };
      }
      if (message.path === "/api/jobs/with-audio") {
        return { status: "done", result: { overview: "已整理", source: "transcription", points: [
          { category: "概念", title: "要点", explanation: "示例", time_seconds: 62 },
        ] } };
      }
      return { status: "cancelled" };
    },
  });
  assert.equal(harness.get(".zk-auto").checked, false);
  harness.player.currentTime = 4;
  harness.tick();
  assert.equal(harness.calls.filter((call) => call.path === "/api/analyze").length, 0);
  harness.get(".zk-start").click();
  await settle();
  const first = harness.calls.find((call) => call.path === "/api/analyze");
  assert.equal(first.body.allow_transcription, false);
  assert.match(harness.get(".zk-body").textContent, /5:02/);
  assert.match(harness.get(".zk-body").textContent, /可能产生 AI 服务费用/);
  harness.get(".zk-confirm-transcription").click();
  await settle();
  const requests = harness.calls.filter((call) => call.path === "/api/analyze");
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.allow_transcription, true);
  assert.match(harness.get(".zk-body").textContent, /要点/);
  harness.get(".zk-time").click();
  assert.equal(harness.player.currentTime, 62);
  assert.equal(harness.shell.classList.contains("zk-collapsed"), false);
});

test("panel actions open the configured dashboard and extension settings", () => {
  const harness = createHarness({ respond: () => ({}) });
  harness.get(".zk-dashboard").click();
  harness.get(".zk-options").click();
  assert.equal(harness.calls[0].kind, "open-dashboard");
  assert.equal(harness.calls[1].kind, "open-options");
});

test("a skipped video stays idle and the stop button releases its lease", async () => {
  const harness = createHarness({
    respond(message) {
      if (message.path === "/api/status") return { configured: true };
      if (message.path === "/api/analyze") return { job_id: "long-job", lease_id: "lease-1" };
      if (message.path === "/api/jobs/long-job") return { status: "queued", progress: 10 };
      return { status: "cancelled" };
    },
  });
  harness.get(".zk-skip").click();
  harness.player.currentTime = 4;
  harness.tick();
  assert.equal(harness.calls.filter((call) => call.path === "/api/analyze").length, 0);
  harness.get(".zk-start").click();
  await settle();
  assert.equal(harness.get(".zk-cancel").hidden, false);
  harness.get(".zk-cancel").click();
  await settle();
  assert.equal(harness.calls.filter((call) => call.path === "/api/jobs/long-job/cancel").length, 1);
  assert.match(harness.get(".zk-body").textContent, /已停止整理/);
});

test("automatic analysis shows partial points before completion", async () => {
  let resolveFinal;
  let jobReads = 0;
  const harness = createHarness({
    respond(message) {
      if (message.path === "/api/status") return { configured: true };
      if (message.path === "/api/analyze") return { job_id: "partial-job", lease_id: "lease-2" };
      if (message.path === "/api/jobs/partial-job") {
        if (++jobReads === 1) return {
          status: "summarizing", progress: 70, partial_overview: "正在分段整理",
          partial_points: [{ category: "方法", title: "先看到的知识点", explanation: "阶段结果", time_seconds: 12 }],
        };
        return new Promise((resolve) => { resolveFinal = resolve; });
      }
      return { status: "cancelled" };
    },
  });
  assert.equal(harness.get(".zk-auto").checked, true);
  harness.player.currentTime = 4;
  harness.tick();
  await settle();
  assert.equal(harness.calls.filter((call) => call.path === "/api/analyze").length, 1);
  assert.match(harness.get(".zk-body").textContent, /整理中 · 70%/);
  assert.match(harness.get(".zk-body").textContent, /先看到的知识点/);
  resolveFinal({ status: "done", result: { overview: "整理完成", points: [
    { category: "方法", title: "最终知识点", explanation: "完整结果", time_seconds: 14 },
  ] } });
  await settle();
  assert.match(harness.get(".zk-body").textContent, /最终知识点/);
  assert.doesNotMatch(harness.get(".zk-body").textContent, /整理中 · 70%/);
});

test("automatic setting persists and only starts when enabled", async () => {
  const harness = createHarness({
    respond(message) {
      if (message.path === "/api/status") return { configured: true };
      if (message.path === "/api/analyze") return { job_id: "short-job", lease_id: "lease-3" };
      return { status: "done", result: { overview: "完成", points: [] } };
    },
  });
  const checkbox = harness.get(".zk-auto");
  checkbox.checked = false;
  checkbox.change();
  assert.equal(harness.local.zkAutoAnalyze, false);
  harness.player.currentTime = 4;
  harness.tick();
  assert.equal(harness.calls.filter((call) => call.path === "/api/analyze").length, 0);
  checkbox.checked = true;
  checkbox.change();
  assert.equal(harness.local.zkAutoAnalyze, true);
  harness.tick();
  await settle();
  assert.equal(harness.calls.filter((call) => call.path === "/api/analyze").length, 1);
});

test("offers explicit Bilibili summary import after subtitles are unavailable", async () => {
  const summary = { overview: "B站课程总结", end_seconds: 300, points: [
    { title: "去心邻域", explanation: "不取中心点。", category: "函数极限", time_seconds: 144 },
  ] };
  const harness = createHarness({
    storage: { zkCollapsed: false, zkAutoAnalyze: false }, courseSummary: summary,
    respond(message) {
      if (message.path === "/api/status") return { configured: true };
      if (message.path === "/api/analyze") return { job_id: "caption-check", lease_id: "lease-4" };
      if (message.path === "/api/jobs/caption-check") return { status: "error", error_code: "transcription_required", duration_seconds: 300 };
      if (message.path === "/api/import-course-summary") return {
        imported: true, result: { ...summary, source: "bilibili_course_summary" },
      };
      return {};
    },
  });
  harness.tick();
  harness.get(".zk-start").click();
  await settle();
  assert.match(harness.get(".zk-body").textContent, /转写音频/);
  harness.get(".zk-import-summary").click();
  await settle();
  const importCall = harness.calls.find((call) => call.path === "/api/import-course-summary");
  assert.equal(importCall.body.url, "https://www.bilibili.com/video/BV1234567890/");
  assert.equal(importCall.body.points[0].time_seconds, 144);
  assert.match(harness.get(".zk-body").textContent, /去心邻域/);
  assert.match(harness.get(".zk-footer-text").textContent, /B站课程总结/);
});

test("offers course summary import after transcription connection fails", async () => {
  const harness = createHarness({
    storage: { zkCollapsed: false, zkAutoAnalyze: false },
    courseSummary: { overview: "课程总结", points: [{ title: "概念", explanation: "说明", category: "定义", time_seconds: 5 }] },
    respond(message) {
      if (message.path === "/api/status") return { configured: true };
      if (message.path === "/api/analyze") return { job_id: "transcription", lease_id: "lease-5" };
      if (message.path === "/api/jobs/transcription") return { status: "error", error: "音频转文字服务连接失败：超时" };
      return {};
    },
  });
  harness.get(".zk-start").click();
  await settle();
  assert.ok(harness.get(".zk-import-summary"));
  assert.equal(harness.calls.filter((call) => call.path === "/api/import-course-summary").length, 0);
});

test("Bilibili summary import is available without an AI key", async () => {
  const summary = { overview: "课程总结", end_seconds: 300, points: [
    { title: "概念", explanation: "说明", category: "定义", time_seconds: 5 },
  ] };
  const harness = createHarness({
    storage: { zkCollapsed: false, zkAutoAnalyze: false }, courseSummary: summary,
    respond(message) {
      if (message.path === "/api/status") return { configured: false };
      if (message.path.startsWith("/api/videos/")) throw Object.assign(new Error("Not found"), { status: 404 });
      if (message.path === "/api/import-course-summary") return {
        imported: true, result: { ...summary, source: "bilibili_course_summary" },
      };
      throw new Error("AI analysis should not start");
    },
  });
  harness.tick();
  harness.get(".zk-start").click();
  await settle();
  assert.ok(harness.get(".zk-import-summary"));
  assert.equal(harness.calls.filter((call) => call.path === "/api/analyze").length, 0);
  harness.get(".zk-import-summary").click();
  await settle();
  assert.match(harness.get(".zk-body").textContent, /概念/);
});

test("does not offer a save action while the local service is unreachable", async () => {
  const harness = createHarness({
    storage: { zkCollapsed: false, zkAutoAnalyze: false },
    courseSummary: { overview: "课程总结", points: [{ title: "概念", explanation: "说明", category: "定义", time_seconds: 5 }] },
    respond() { throw new Error("无法连接本地服务。请先启动知点。"); },
  });
  harness.get(".zk-start").click();
  await settle();
  assert.equal(harness.get(".zk-import-summary"), null);
  assert.match(harness.get(".zk-body").textContent, /无法连接本地服务/);
});

test("rechecks a later Bilibili summary and rejects stale page duration", async () => {
  const summary = { overview: "课程总结", end_seconds: 3440, points: [
    { title: "极限", explanation: "函数极限的定义", category: "定义", time_seconds: 100 },
  ] };
  const harness = createHarness({
    storage: { zkCollapsed: false, zkAutoAnalyze: false },
    respond(message) {
      if (message.path === "/api/status") return { configured: false };
      if (message.path.startsWith("/api/videos/")) throw Object.assign(new Error("Not found"), { status: 404 });
      if (message.path === "/api/import-course-summary") return {
        imported: true, result: { ...summary, source: "bilibili_course_summary" },
      };
      return {};
    },
  });
  harness.player.duration = 3432;
  harness.tick();
  harness.get(".zk-start").click();
  await settle();
  harness.get(".zk-import-summary").click();
  assert.match(harness.get(".zk-body").textContent, /打开当前分 P/);
  harness.setCourseSummary(summary);
  harness.player.duration = 3000;
  harness.tick();
  harness.get(".zk-import-summary").click();
  assert.equal(harness.calls.filter((call) => call.path === "/api/import-course-summary").length, 0);
  harness.player.duration = 3432;
  harness.tick();
  harness.tick();
  harness.get(".zk-import-summary").click();
  await settle();
  assert.equal(harness.calls.filter((call) => call.path === "/api/import-course-summary").length, 1);
});

test("a cached imported note opens without an AI key", async () => {
  const result = { overview: "已保存的课程总结", source: "bilibili_course_summary", points: [] };
  const harness = createHarness({
    storage: { zkCollapsed: false, zkAutoAnalyze: false },
    respond(message) {
      if (message.path === "/api/status") return { configured: false };
      if (message.path === "/api/videos/BV1234567890-p1") return result;
      throw new Error("No other request expected");
    },
  });
  harness.get(".zk-start").click();
  await settle();
  assert.match(harness.get(".zk-body").textContent, /已保存的课程总结/);
  assert.equal(harness.calls.filter((call) => call.path === "/api/analyze").length, 0);
  assert.equal(harness.get(".zk-import-summary"), null);
});

test("course summary import fails closed after an in-page P change", async () => {
  const summary = { overview: "旧分P总结", end_seconds: 300, points: [
    { title: "旧知识点", explanation: "旧内容", category: "定义", time_seconds: 5 },
  ] };
  const harness = createHarness({
    storage: { zkCollapsed: false, zkAutoAnalyze: false }, courseSummary: summary,
    respond(message) {
      if (message.path === "/api/status") return { configured: false };
      if (message.path.startsWith("/api/videos/")) throw Object.assign(new Error("Not found"), { status: 404 });
      return {};
    },
  });
  harness.tick();
  harness.setPage(2);
  harness.tick();
  harness.get(".zk-start").click();
  await settle();
  harness.get(".zk-import-summary").click();
  assert.match(harness.get(".zk-body").textContent, /刷新视频页/);
  assert.equal(harness.calls.filter((call) => call.path === "/api/import-course-summary").length, 0);
});

test("leaving and returning to a video in one document still requires a reload", async () => {
  const summary = { overview: "旧总结", end_seconds: 300, points: [
    { title: "旧知识点", explanation: "旧内容", category: "定义", time_seconds: 5 },
  ] };
  const harness = createHarness({
    storage: { zkCollapsed: false, zkAutoAnalyze: false }, courseSummary: summary,
    respond(message) {
      if (message.path === "/api/status") return { configured: false };
      if (message.path.startsWith("/api/videos/")) throw Object.assign(new Error("Not found"), { status: 404 });
      return {};
    },
  });
  harness.leaveVideo();
  harness.tick();
  harness.setPage(2);
  harness.tick();
  harness.tick();
  harness.get(".zk-start").click();
  await settle();
  harness.get(".zk-import-summary").click();
  assert.match(harness.get(".zk-body").textContent, /刷新视频页/);
  assert.equal(harness.calls.filter((call) => call.path === "/api/import-course-summary").length, 0);
});
