(() => {
  const MAX_POINTS = 100;
  const CLOCK = /\b(?:\d{1,2}:)?\d{1,2}:\d{2}\b/g;

  function parseClock(value) {
    const parts = String(value || "").split(":").map(Number);
    if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isInteger(part))) return null;
    if (parts.at(-1) > 59 || (parts.length === 3 && parts.at(-2) > 59)) return null;
    return parts.reduce((seconds, part) => seconds * 60 + part, 0);
  }

  function clocks(value) {
    return [...String(value || "").matchAll(CLOCK)].map((match) => parseClock(match[0]));
  }

  function clean(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function hasClass(node, name) {
    return node?.classList?.contains(name) || false;
  }

  function readableText(node) {
    if (node.nodeType === 3) return node.nodeValue || "";
    if (node.nodeType !== 1) return "";
    if (["time-pill-wrap", "badge", "video-frame"].some((name) => hasClass(node, name))) return "";
    if (hasClass(node, "math")) {
      const latex = clean(node.querySelector('annotation[encoding="application/x-tex"]')?.textContent);
      return latex ? `$${latex}$` : clean(node.getAttribute?.("aria-label"));
    }
    const content = [...node.childNodes].map(readableText).join("");
    return hasClass(node, "board-line") ? `${content}；` : content;
  }

  function point(category, title, explanation, time) {
    const fullText = clean(explanation);
    const name = clean(title);
    if (!name || !fullText || name.length > 100 || fullText.length > 500 || category.length > 40) return null;
    return { category, title: name, explanation: fullText, time_seconds: time };
  }

  function paragraphTitle(text) {
    const lead = text.match(/^(.{2,50}?)[：:]/)?.[1];
    return clean(lead || text.slice(0, 48));
  }

  function extract(doc = document) {
    const view = doc.querySelector(".video-note-sidebar-noteview");
    if (!view || typeof view.querySelectorAll !== "function" || view.querySelector(".note-status")) return null;
    if (typeof view.getClientRects === "function" && !view.getClientRects().length) return null;
    const sections = [...view.querySelectorAll(".note-section")];
    if (!sections.length || sections.length > 40) return null;
    for (const math of view.querySelectorAll(".math")) {
      if (!clean(math.querySelector('annotation[encoding="application/x-tex"]')?.textContent) &&
          !clean(math.getAttribute?.("aria-label"))) return null;
    }

    const points = [];
    const chapterTitles = [];
    let previousEnd = -1;
    for (const section of sections) {
      const head = section.querySelector(".section-head");
      const body = section.querySelector(".section-body");
      const chapter = clean(head?.querySelector(".section-title")?.textContent).replace(/^\d+\.\s*/, "");
      const range = clocks(head?.querySelector(".time-pill")?.textContent);
      if (!body || !chapter || chapter.length > 40 || range.length !== 2) return null;
      const [start, end] = range;
      if (start === null || end === null || end <= start || start < previousEnd - 1) return null;
      previousEnd = end;
      chapterTitles.push(chapter);

      let currentTime = start;
      const countBefore = points.length;
      for (const block of body.children) {
        if (hasClass(block, "para")) {
          const inlineTimes = block.querySelectorAll(".time-pill-inline");
          if (inlineTimes.length > 1) return null;
          const inlineTime = inlineTimes[0];
          if (inlineTime) {
            const parsed = clocks(inlineTime.textContent);
            if (parsed.length !== 1 || parsed[0] === null || parsed[0] < currentTime || parsed[0] > end + 1) return null;
            currentTime = parsed[0];
          }
          const text = clean(readableText(block));
          if (!text) continue;
          const item = point(chapter, paragraphTitle(text), text, currentTime);
          if (!item) return null;
          points.push(item);
        } else if (hasClass(block, "board")) {
          const label = clean(block.querySelector(".board-label")?.textContent);
          const text = clean(readableText(block.querySelector(".board-body")));
          if (!text) continue;
          const item = point(chapter, `${chapter} · ${label || "板书"}`, text, currentTime);
          if (!item) return null;
          points.push(item);
        }
        if (points.length > MAX_POINTS) return null;
      }
      if (points.length === countBefore) return null;
    }

    const overview = `B站课程总结，共 ${sections.length} 个章节：${chapterTitles.join("、")}`;
    if (overview.length > 800) return null;
    return { overview, points, end_seconds: previousEnd };
  }

  window.ZhiDianCourseSummary = { extract };
})();
