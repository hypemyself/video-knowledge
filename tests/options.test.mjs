import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const source = await readFile(new URL("../extension/options.js", import.meta.url), "utf8");

function harness({ permissionGranted = true } = {}) {
  const elements = new Map();
  const events = new Map();
  const saved = [];
  const requested = [];
  const requests = [];
  for (const id of ["connection-form", "origin", "token", "status", "save", "use-local", "toggle-token"]) {
    elements.set(id, {
      value: "", textContent: "", type: id === "token" ? "password" : "text", disabled: false,
      classList: { toggle() {} }, setAttribute() {},
      addEventListener(name, callback) { events.set(`${id}:${name}`, callback); },
    });
  }
  const chrome = {
    permissions: { request: async (value) => { requested.push(value); return permissionGranted; } },
    storage: { local: {
      get: async () => ({}),
      set: async (value) => { saved.push(value); },
    } },
  };
  const fetch = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, status: 200 };
  };
  runInNewContext(source, { chrome, document: { getElementById: (id) => elements.get(id) }, fetch, URL });
  const submit = () => events.get("connection-form:submit")({ preventDefault() {} });
  return { elements, saved, requested, requests, submit };
}

test("cloud settings request only the selected host and send the token as a header", async () => {
  const app = harness();
  await Promise.resolve();
  app.elements.get("origin").value = "https://notes.example.test:8443/";
  app.elements.get("token").value = "secret-123";
  await app.submit();
  assert.equal(app.requested.length, 1);
  assert.equal(app.requested[0].origins[0], "https://notes.example.test/*");
  assert.equal(app.saved[0].zkApiOrigin, "https://notes.example.test:8443");
  assert.equal(app.saved[0].zkAccessToken, "secret-123");
  assert.equal(app.requests[0].url, "https://notes.example.test:8443/api/status");
  assert.equal(app.requests[0].options.headers.Authorization, "Bearer secret-123");
  assert.equal(app.requests[0].url.includes("secret-123"), false);
});

test("non-HTTPS remote addresses and declined host permissions are not saved", async () => {
  const app = harness({ permissionGranted: false });
  await Promise.resolve();
  app.elements.get("origin").value = "http://notes.example.test";
  app.elements.get("token").value = "secret";
  await app.submit();
  assert.equal(app.requested.length, 0);
  assert.equal(app.saved.length, 0);

  app.elements.get("origin").value = "https://notes.example.test";
  await app.submit();
  assert.equal(app.requested.length, 1);
  assert.equal(app.saved.length, 0);
});

test("the default local server needs no optional host permission", async () => {
  const app = harness();
  await Promise.resolve();
  app.elements.get("origin").value = "http://127.0.0.1:8765";
  await app.submit();
  assert.equal(app.requested.length, 0);
  assert.equal(app.saved[0].zkApiOrigin, "http://127.0.0.1:8765");
  assert.equal(app.requests[0].url, "http://127.0.0.1:8765/api/status");
});
