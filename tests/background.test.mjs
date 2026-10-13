import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

test("storage failures do not strand an analysis lease", async () => {
  let onMessage;
  let writeCount = 0;
  const snapshots = [];
  const chrome = {
    action: { onClicked: { addListener() {} } },
    tabs: {
      create() {},
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
    },
    runtime: { onMessage: { addListener(listener) { onMessage = listener; } }, openOptionsPage() {} },
    storage: {
      local: { get: async () => ({}) },
      session: {
        get: async () => { throw new Error("temporary read failure"); },
        set: async (value) => {
          snapshots.push(value);
          if (++writeCount === 1) throw new Error("temporary write failure");
        },
      },
    },
  };
  const fetch = async (url) => ({
    ok: true,
    json: async () => url.endsWith("/api/analyze")
      ? { job_id: "job-1", lease_id: "lease-1" }
      : { status: "done", result: {} },
  });
  const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  runInNewContext(source, { chrome, fetch, URL });

  const send = (method, path) => new Promise((resolve) => {
    assert.equal(onMessage({ kind: "api", method, path }, { tab: { id: 7 } }, resolve), true);
  });
  const started = await send("POST", "/api/analyze");
  assert.equal(started.ok, true);
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].zkActiveLeases[7][0][0], "lease-1");
  assert.equal(snapshots[0].zkActiveLeases[7][0][1].jobId, "job-1");
  assert.equal(snapshots[0].zkActiveLeases[7][0][1].origin, "http://127.0.0.1:8765");

  const finished = await send("GET", "/api/jobs/job-1");
  assert.equal(finished.ok, true);
  assert.equal(writeCount, 2);
  assert.deepEqual(Object.keys(snapshots[1].zkActiveLeases), []);
});

test("cloud requests use the configured HTTPS origin and Bearer token", async () => {
  let onMessage;
  let onClicked;
  const opened = [];
  const requests = [];
  const token = "private-token-123";
  const chrome = {
    action: { onClicked: { addListener(listener) { onClicked = listener; } } },
    tabs: {
      create: (tab) => opened.push(tab),
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
    },
    runtime: { onMessage: { addListener(listener) { onMessage = listener; } }, openOptionsPage() {} },
    storage: {
      local: { get: async () => ({ zkApiOrigin: "https://notes.example.test", zkAccessToken: token }) },
      session: { get: async () => ({}), set: async () => {} },
    },
  };
  const fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ configured: true }) };
  };
  const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  runInNewContext(source, { chrome, fetch, URL });

  const result = await new Promise((resolve) => {
    assert.equal(onMessage({ kind: "api", method: "GET", path: "/api/status" }, { tab: { id: 1 } }, resolve), true);
  });
  assert.equal(result.ok, true);
  assert.equal(requests[0].url, "https://notes.example.test/api/status");
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${token}`);
  assert.equal(requests[0].options.credentials, "omit");
  assert.equal(requests[0].options.redirect, "error");
  onClicked();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opened[0].url, "https://notes.example.test");
  assert.equal(JSON.stringify(opened).includes(token), false);
});

test("invalid remote origin is rejected before any request", async () => {
  let onMessage;
  let fetchCount = 0;
  const chrome = {
    action: { onClicked: { addListener() {} } },
    tabs: { create() {}, onRemoved: { addListener() {} }, onUpdated: { addListener() {} } },
    runtime: { onMessage: { addListener(listener) { onMessage = listener; } }, openOptionsPage() {} },
    storage: {
      local: { get: async () => ({ zkApiOrigin: "http://untrusted.example.test", zkAccessToken: "secret" }) },
      session: { get: async () => ({}), set: async () => {} },
    },
  };
  const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  runInNewContext(source, { chrome, URL, fetch: async () => { fetchCount++; } });
  const result = await new Promise((resolve) => {
    assert.equal(onMessage({ kind: "api", path: "/api/status" }, { tab: { id: 1 } }, resolve), true);
  });
  assert.equal(result.ok, false);
  assert.equal(fetchCount, 0);
});

test("a tab closes its lease on the original server after settings change", async () => {
  let onMessage;
  let onRemoved;
  let origin = "https://first.example.test";
  let token = "first-token";
  const requests = [];
  const chrome = {
    action: { onClicked: { addListener() {} } },
    tabs: {
      create() {},
      onRemoved: { addListener(listener) { onRemoved = listener; } },
      onUpdated: { addListener() {} },
    },
    runtime: { onMessage: { addListener(listener) { onMessage = listener; } }, openOptionsPage() {} },
    storage: {
      local: { get: async () => ({ zkApiOrigin: origin, zkAccessToken: token }) },
      session: { get: async () => ({}), set: async () => {} },
    },
  };
  const fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ job_id: "job-1", lease_id: "lease-1" }) };
  };
  const source = await readFile(new URL("../extension/background.js", import.meta.url), "utf8");
  runInNewContext(source, { chrome, URL, fetch });
  await new Promise((resolve) => {
    assert.equal(onMessage({ kind: "api", method: "POST", path: "/api/analyze" }, { tab: { id: 3 } }, resolve), true);
  });
  origin = "https://second.example.test";
  token = "second-token";
  onRemoved(3);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests[1].url, "https://first.example.test/api/jobs/job-1/cancel");
  assert.equal(requests[1].options.headers.Authorization, "Bearer first-token");
});
