/* STARCHART X-Ray settings: server URL, with a permission request for non-local servers. */
"use strict";

const api = globalThis.browser ?? globalThis.chrome;
const DEFAULT_SERVER = "http://127.0.0.1:4477";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const form = document.getElementById("form");
const input = document.getElementById("server-url");
const result = document.getElementById("result");

function report(kind, text) {
  result.className = `result-line ${kind}`;
  result.textContent = text;
}

function normalize(raw) {
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.origin + url.pathname.replace(/\/+$/, "");
}

async function ensurePermission(serverUrl) {
  const url = new URL(serverUrl);
  if (LOCAL_HOSTS.has(url.hostname) && url.protocol === "http:") return true;
  return api.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] });
}

async function test(serverUrl) {
  report("", "Testing…");
  try {
    const res = await fetch(`${serverUrl}/health`, { cache: "no-store" });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(body.error || `server answered ${res.status}`);
    report("ok", `Connected to "${body.name}" · ${body.nodes} stars, ${body.edges} edges.`);
  } catch (error) {
    report("err", `Cannot reach ${serverUrl}: ${error.message}. Run: starchart serve`);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const serverUrl = normalize(input.value);
  if (!serverUrl) {
    input.setAttribute("aria-invalid", "true");
    report("err", "Enter an http:// or https:// URL.");
    return;
  }
  input.removeAttribute("aria-invalid");
  // The permission prompt must open inside the submit gesture, before any other await.
  ensurePermission(serverUrl).then(async (granted) => {
    if (!granted) {
      report("err", "X-Ray needs permission to reach that server.");
      return;
    }
    await api.storage.local.set({ serverUrl });
    input.value = serverUrl;
    await test(serverUrl);
  }, (error) => report("err", error.message));
});

document.getElementById("test").addEventListener("click", () => {
  const serverUrl = normalize(input.value);
  if (serverUrl) test(serverUrl);
  else report("err", "Enter an http:// or https:// URL.");
});

document.getElementById("reset").addEventListener("click", async () => {
  input.value = DEFAULT_SERVER;
  input.removeAttribute("aria-invalid");
  await api.storage.local.set({ serverUrl: DEFAULT_SERVER });
  report("ok", "Reset to the default server.");
});

api.storage.local.get({ serverUrl: DEFAULT_SERVER }).then(({ serverUrl }) => {
  input.value = serverUrl;
});
