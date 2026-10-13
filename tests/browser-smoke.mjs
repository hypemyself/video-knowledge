import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

const port = process.argv[2] || "9225";
const screenshotPath = process.argv[3];
const width = Number(process.argv[4]);
const height = Number(process.argv[5]);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const page = targets.find((target) => target.type === "page" && target.url.includes("bilibili.com/video/"));
assert(page, "Bilibili video tab is not open in the test browser");

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message));
  else resolve(message.result);
});

function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

let state;
for (let attempt = 0; attempt < 50; attempt++) {
  const result = await command("Runtime.evaluate", {
    expression: `(() => {
    const host = document.getElementById("zhidian-video-panel");
    const panel = host?.shadowRoot?.querySelector(".zk-shell");
    if (panel?.classList.contains("zk-collapsed")) {
      host.shadowRoot.querySelector(".zk-reopen").click();
    }
    return {
      injected: Boolean(host),
      expanded: Boolean(panel && !panel.classList.contains("zk-collapsed")),
      heading: host?.shadowRoot?.querySelector(".zk-brand")?.textContent || "",
      status: host?.shadowRoot?.querySelector(".zk-state-title")?.textContent || "",
    };
  })()`,
    returnByValue: true,
  });
  state = result.result?.value;
  if (state?.injected) break;
  await new Promise((resolve) => setTimeout(resolve, 300));
}
assert(state?.injected, "Extension was not injected into the video page");
assert(state?.expanded, "Extension panel did not open");
assert(state?.heading.includes("知点"), "Extension panel heading is missing");

if (screenshotPath) {
  if (width > 0 && height > 0) {
    await command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  }
  const screenshot = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(screenshotPath, Buffer.from(screenshot.data, "base64"));
}

const navigation = await command("Runtime.evaluate", {
  expression: `(async () => {
    const original = location.href;
    const host = document.getElementById("zhidian-video-panel");
    history.replaceState({}, "", "/popular/zhidian-smoke");
    await new Promise((resolve) => setTimeout(resolve, 1400));
    const hiddenAway = host.style.display === "none";
    history.replaceState({}, "", original);
    await new Promise((resolve) => setTimeout(resolve, 1400));
    return { hiddenAway, visibleBack: host.style.display !== "none" };
  })()`,
  awaitPromise: true,
  returnByValue: true,
});
assert(navigation.result?.value?.hiddenAway, "Panel remained visible after leaving the video route");
assert(navigation.result?.value?.visibleBack, "Panel did not return to the video route");
console.log(JSON.stringify({ ...state, navigation: navigation.result.value }, null, 2));
socket.close();
