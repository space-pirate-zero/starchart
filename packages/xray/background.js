/*
 * STARCHART X-Ray background worker.
 * - Fetches from the local STARCHART server on behalf of content scripts (no page CSP or
 *   mixed-content problems, and pages never see the server).
 * - Injects the X-Ray scanner into a tab on demand, and auto-scans pages whose URL matches
 *   an artifact URL when the user opted in and granted that origin.
 */
/* global importScripts */
"use strict";

if (typeof importScripts === "function" && !globalThis.StarchartMatch) importScripts("src-shared/match.js");

const api = globalThis.browser ?? globalThis.chrome;
const DEFAULT_SERVER = "http://127.0.0.1:4477";
const DEFAULTS = { serverUrl: DEFAULT_SERVER, autoScan: false, showUnbound: false };
const PAYLOAD_TTL_MS = 5000;

let payloadCache = { at: 0, server: "", data: null };

async function settings() {
  return api.storage.local.get(DEFAULTS);
}

function serverBase(url) {
  return String(url || DEFAULT_SERVER).replace(/\/+$/, "");
}

async function fetchJson(path) {
  const { serverUrl } = await settings();
  const base = serverBase(serverUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(base + path, { cache: "no-store", signal: controller.signal });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body && body.error) || `server answered ${res.status}`);
    return body;
  } catch (error) {
    if (error && error.name === "AbortError") throw new Error(`no answer from ${base} (is "starchart serve" running?)`);
    if (error instanceof TypeError) throw new Error(`cannot reach ${base} (is "starchart serve" running?)`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function xrayPayload(force) {
  const { serverUrl } = await settings();
  const server = serverBase(serverUrl);
  const fresh = Date.now() - payloadCache.at < PAYLOAD_TTL_MS && payloadCache.server === server;
  if (!force && fresh && payloadCache.data) return payloadCache.data;
  const data = await fetchJson("/xray.json");
  payloadCache = { at: Date.now(), server, data };
  return data;
}

async function injectAndScan(tabId, options) {
  const [probe] = await api.scripting.executeScript({
    target: { tabId },
    func: () => Boolean(globalThis.StarchartXray),
  });
  if (!probe || !probe.result) {
    await api.scripting.insertCSS({ target: { tabId }, files: ["xray.css"] });
    await api.scripting.executeScript({ target: { tabId }, files: ["src-shared/match.js", "xray.js"] });
  }
  const [run] = await api.scripting.executeScript({
    target: { tabId },
    func: (opts) => globalThis.StarchartXray.scan(opts),
    args: [options || {}],
  });
  return run ? run.result : null;
}

async function clearTab(tabId) {
  const [run] = await api.scripting.executeScript({
    target: { tabId },
    func: () => (globalThis.StarchartXray ? globalThis.StarchartXray.clear() : { cleared: 0 }),
  });
  return run ? run.result : null;
}

/** Artifacts whose URL patterns cover `url`. */
function matchingArtifacts(payload, url) {
  const M = globalThis.StarchartMatch;
  return (payload.artifacts || []).filter((a) => (a.urls || []).some((pattern) => M.urlMatches(pattern, url)));
}

const handlers = {
  "starchart:health": () => fetchJson("/health"),
  "starchart:xray": (msg) => xrayPayload(Boolean(msg.force)),
  "starchart:open": async (msg) => {
    const { serverUrl } = await settings();
    const hash = typeof msg.id === "string" && msg.id ? `#${encodeURIComponent(msg.id)}` : "";
    await api.tabs.create({ url: `${serverBase(serverUrl)}/${hash}` });
    return true;
  },
  "starchart:scan-tab": async (msg) => {
    const { showUnbound } = await settings();
    return injectAndScan(msg.tabId, { unbound: msg.unbound ?? showUnbound });
  },
  "starchart:clear-tab": (msg) => clearTab(msg.tabId),
};

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string" || !Object.prototype.hasOwnProperty.call(handlers, msg.type)) return false;
  if (sender.id !== api.runtime.id) return false;
  Promise.resolve()
    .then(() => handlers[msg.type](msg, sender))
    .then(
      (data) => sendResponse({ ok: true, data }),
      (error) => sendResponse({ ok: false, error: error && error.message ? error.message : String(error) }),
    );
  return true;
});

api.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab.url || !/^https?:/.test(tab.url)) return;
  try {
    const { autoScan, showUnbound } = await settings();
    if (!autoScan) return;
    const payload = await xrayPayload(false);
    if (!matchingArtifacts(payload, tab.url).length) return;
    const origin = globalThis.StarchartMatch.originPattern(tab.url);
    if (!origin || !(await api.permissions.contains({ origins: [origin] }))) return;
    await injectAndScan(tabId, { unbound: showUnbound });
  } catch {
    // Auto-scan is best effort: the server may be down or the page may forbid injection.
  }
});
