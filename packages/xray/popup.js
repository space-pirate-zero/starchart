/* STARCHART X-Ray popup: connection status, SCAN PAGE, and the auto-scan opt-in. */
"use strict";

const api = globalThis.browser ?? globalThis.chrome;
const M = globalThis.StarchartMatch;
const DEFAULTS = { serverUrl: "http://127.0.0.1:4477", autoScan: false, showUnbound: false };

const $ = (id) => document.getElementById(id);
const ui = {
  dot: $("dot"),
  statusText: $("status-text"),
  project: $("project"),
  scan: $("scan"),
  clear: $("clear"),
  open: $("open"),
  result: $("result"),
  nSync: $("n-sync"),
  nStale: $("n-stale"),
  nUnbound: $("n-unbound"),
  message: $("message"),
  unbound: $("unbound"),
  auto: $("auto"),
  autoHint: $("auto-hint"),
  server: $("server"),
  settings: $("settings"),
};

/** Origins the auto-scan needs, computed up front so the permission request stays inside the click. */
let autoOrigins = [];

async function send(message) {
  const response = await api.runtime.sendMessage(message);
  if (!response) throw new Error("the X-Ray background worker did not answer");
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

async function activeTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function setStatus(kind, text, project) {
  ui.dot.className = `dot ${kind}`;
  ui.statusText.textContent = text;
  ui.project.textContent = project || "";
}

function setMessage(text) {
  ui.message.textContent = text || "";
}

function showResult(summary, unbound) {
  if (!summary || summary.error) {
    ui.result.hidden = true;
    setMessage(summary && summary.error ? summary.error : "The page did not return a result.");
    return;
  }
  ui.result.hidden = false;
  ui.nSync.textContent = String(summary.sync);
  ui.nStale.textContent = String(summary.stale);
  ui.nUnbound.textContent = unbound ? String(summary.unbound) : "–";
  const pages = summary.artifacts.map((a) => a.id + (a.stale ? " (stale)" : "")).join(", ");
  setMessage(summary.stale ? `This page still shows ${summary.stale} old value${summary.stale === 1 ? "" : "s"}.` : "");
  if (pages) ui.project.textContent = `This page: ${pages}`;
}

function scannable(tab) {
  return Boolean(tab && tab.id !== undefined && tab.url && /^(https?|file):/.test(tab.url));
}

async function connect() {
  const settings = await api.storage.local.get(DEFAULTS);
  ui.server.textContent = settings.serverUrl;
  ui.unbound.checked = Boolean(settings.showUnbound);
  ui.auto.checked = Boolean(settings.autoScan);
  const tab = await activeTab();
  try {
    const health = await send({ type: "starchart:health" });
    setStatus("ok", `CONNECTED · ${health.nodes} stars`, health.name);
    ui.open.disabled = false;
    ui.scan.disabled = !scannable(tab);
    ui.clear.disabled = !scannable(tab);
    if (!scannable(tab)) setMessage("This page cannot be scanned (browser pages are off limits).");
    const payload = await send({ type: "starchart:xray" });
    const origins = new Set();
    for (const artifact of payload.artifacts) {
      for (const url of artifact.urls) {
        const origin = M.originPattern(url);
        if (origin) origins.add(origin);
      }
    }
    autoOrigins = [...origins].sort();
    ui.autoHint.textContent = autoOrigins.length
      ? `Scans pages matching artifact URLs on: ${autoOrigins.map((o) => o.replace(/\/\*$/, "")).join(", ")}`
      : "No artifact declares a URL yet (binding.url or meta.urls), so there is nothing to auto-scan.";
    ui.auto.disabled = autoOrigins.length === 0 && !ui.auto.checked;
  } catch (error) {
    setStatus("err", "NOT CONNECTED", "");
    setMessage(`${error.message} Run: starchart serve`);
  }
}

ui.scan.addEventListener("click", async () => {
  const tab = await activeTab();
  if (!scannable(tab)) return;
  ui.scan.disabled = true;
  ui.scan.textContent = "SCANNING…";
  setMessage("");
  try {
    const unbound = ui.unbound.checked;
    const summary = await send({ type: "starchart:scan-tab", tabId: tab.id, unbound });
    showResult(summary, unbound);
  } catch (error) {
    setMessage(error.message);
  } finally {
    ui.scan.disabled = false;
    ui.scan.textContent = "SCAN PAGE";
  }
});

ui.clear.addEventListener("click", async () => {
  const tab = await activeTab();
  if (!scannable(tab)) return;
  try {
    const res = await send({ type: "starchart:clear-tab", tabId: tab.id });
    ui.result.hidden = true;
    setMessage(res && res.cleared ? `Cleared ${res.cleared} marks.` : "Nothing to clear.");
  } catch (error) {
    setMessage(error.message);
  }
});

ui.open.addEventListener("click", () => {
  send({ type: "starchart:open", id: "" }).then(() => window.close(), (error) => setMessage(error.message));
});

ui.unbound.addEventListener("change", () => {
  api.storage.local.set({ showUnbound: ui.unbound.checked });
});

ui.auto.addEventListener("change", () => {
  if (!ui.auto.checked) {
    api.storage.local.set({ autoScan: false });
    return;
  }
  // Must run synchronously inside the click so the browser treats it as a user gesture.
  api.permissions.request({ origins: autoOrigins }).then(
    (granted) => {
      ui.auto.checked = granted;
      api.storage.local.set({ autoScan: granted });
      setMessage(granted ? "" : "Auto-scan needs access to those sites.");
    },
    (error) => {
      ui.auto.checked = false;
      setMessage(error.message);
    },
  );
});

ui.settings.addEventListener("click", () => {
  api.runtime.openOptionsPage();
});

connect();
