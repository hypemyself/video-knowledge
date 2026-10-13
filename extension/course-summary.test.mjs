import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("./course-summary.js", import.meta.url), "utf8");
const window = {};
runInNewContext(source, { window });
const { extract } = window.ZhiDianCourseSummary;

class TextNode {
  constructor(value) { this.nodeType = 3; this.nodeValue = value; }
  get textContent() { return this.nodeValue; }
}

class Element {
  constructor(className, ...children) {
    this.nodeType = 1;
    this.className = className;
    this.children = children.filter((child) => child.nodeType === 1);
    this.childNodes = children;
    this.classList = { contains: (name) => className.split(" ").includes(name) };
  }
  get textContent() { return this.childNodes.map((child) => child.textContent).join(""); }
  getClientRects() { return [1]; }
  getAttribute() { return null; }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    const name = selector.startsWith(".") ? selector.slice(1) : selector.startsWith("annotation") ? "annotation" : selector;
    const found = [];
    for (const child of this.children) {
      if (child.classList.contains(name)) found.push(child);
      found.push(...child.querySelectorAll(selector));
    }
    return found;
  }
}

const text = (value) => new TextNode(value);
const el = (className, ...children) => new Element(className, ...children);
const paragraph = (time, content) => el("para",
  el("time-pill-wrap", el("time-pill-inline", text(time))), text(content));
const section = (title, range, ...blocks) => el("note-section",
  el("section-head", el("section-title", text(title)), el("time-pill", text(range))),
  el("section-body", ...blocks));
const doc = (view) => ({ querySelector: (selector) => selector === ".video-note-sidebar-noteview" ? view : null });

test("extracts only the rendered course summary chapters, notes and times", () => {
  const board = el("board", el("board-label", text("板书1")),
    el("board-body", el("board-line", text("公式 "), el("math", el("annotation", text("f(x)=x^2"))))));
  const view = el("video-note-sidebar-noteview",
    section("1. 函数极限", "00:00 ~ 20:29", paragraph("02:24", "去心邻域：不取中心点。"), board),
    section("2. 左右极限", "20:30 ~ 37:49", paragraph("32:14", "左极限：从左侧逼近。")));
  const result = extract(doc(view));
  assert.equal(result.points.length, 3);
  assert.equal(result.points[0].time_seconds, 144);
  assert.equal(result.points[0].category, "函数极限");
  assert.match(result.points[1].explanation, /\$f\(x\)=x\^2\$/);
  assert.equal(result.points[2].time_seconds, 1934);
  assert.equal(result.end_seconds, 2269);
  assert.match(result.overview, /2 个章节/);
});

test("accepts long video clocks with two-part minute notation", () => {
  const view = el("video-note-sidebar-noteview",
    section("1. 长视频", "61:00 ~ 75:00", paragraph("62:15", "重点：超过一小时的时间点。")));
  const result = extract(doc(view));
  assert.equal(result.points[0].time_seconds, 3735);
  assert.equal(result.end_seconds, 4500);
});

test("rejects placeholder, hidden, incomplete, and inconsistent course summaries", () => {
  const valid = section("1. 函数极限", "00:00 ~ 20:29", paragraph("02:24", "去心邻域：不取中心点。"));
  assert.equal(extract(doc(el("video-note-sidebar-noteview", el("note-status", text("加载中"))))), null);
  const hidden = el("video-note-sidebar-noteview", valid);
  hidden.getClientRects = () => [];
  assert.equal(extract(doc(hidden)), null);
  assert.equal(extract(doc(el("video-note-sidebar-noteview", section("1. 函数极限", "00:00 ~ 20:29")))), null);
  assert.equal(extract(doc(el("video-note-sidebar-noteview", section("1. 函数极限", "00:00 ~ 20:29", paragraph("21:00", "时间不在章节内。"))))), null);
  assert.equal(extract(doc(el("video-note-sidebar-noteview", valid,
    section("2. 左右极限", "19:00 ~ 37:49", paragraph("20:00", "章节时间重叠。"))))), null);
  const twoTimes = el("para", el("time-pill-inline", text("01:00")), text("第一部分"),
    el("time-pill-inline", text("02:00")), text("第二部分"));
  assert.equal(extract(doc(el("video-note-sidebar-noteview",
    section("1. 函数极限", "00:00 ~ 20:29", twoTimes)))), null);
  const unreadableMath = el("para", el("math", text("unverified rendered formula")));
  assert.equal(extract(doc(el("video-note-sidebar-noteview",
    section("1. 函数极限", "00:00 ~ 20:29", unreadableMath)))), null);
});
