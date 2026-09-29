/*
 * STARCHART X-Ray content script. Injected on demand (never auto-registered) after
 * src-shared/match.js. Publishes globalThis.StarchartXray = { scan, clear }.
 *
 * scan() marks every visible occurrence of a fact value on the page:
 *   green = current value (in sync), red = a previous value the page still shows (stale),
 *   grey = a currency amount no fact accounts for (unbound, opt-in).
 * clear() puts every original text node back exactly where it was.
 */
(function () {
  "use strict";
  if (globalThis.StarchartXray) return;

  var api = globalThis.browser || globalThis.chrome;
  var M = globalThis.StarchartMatch;
  var UI = "starchart-xray-ui";
  var SKIP_TAGS = {
    SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, INPUT: 1, SELECT: 1, OPTION: 1,
    TEMPLATE: 1, IFRAME: 1, CANVAS: 1, SVG: 1, MATH: 1,
  };
  var META_SELECTORS = [
    'meta[property="og:title"]',
    'meta[property="og:description"]',
    'meta[name="description"]',
    'meta[name="twitter:title"]',
    'meta[name="twitter:description"]',
  ];

  var records = [];
  var marks = [];
  var findings = [];
  var payload = null;
  var factsById = new Map();
  var artifactsById = new Map();
  var hud = null;
  var tooltip = null;
  var lastOptions = {};
  var listening = false;

  function send(message) {
    return Promise.resolve(api.runtime.sendMessage(message)).then(function (response) {
      if (!response) throw new Error("no response from the X-Ray background worker");
      if (!response.ok) throw new Error(response.error);
      return response.data;
    });
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---------------------------------------------------------------- DOM walk

  function isEditable(node) {
    var host = node.closest ? node.closest('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]') : null;
    return Boolean(host);
  }

  var visibility = new WeakMap();
  function isVisible(element) {
    if (visibility.has(element)) return visibility.get(element);
    var visible;
    if (typeof element.checkVisibility === "function") {
      visible = element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    } else {
      var style = getComputedStyle(element);
      visible = style.visibility !== "hidden" && style.display !== "none" && element.getClientRects().length > 0;
    }
    visibility.set(element, visible);
    return visible;
  }

  function collectTextNodes(root) {
    var out = [];
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        var parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (!node.nodeValue || !/\S/.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS[parent.tagName.toUpperCase()]) return NodeFilter.FILTER_REJECT;
        if (parent.closest("." + UI + ", mark.starchart-xray, svg, math")) return NodeFilter.FILTER_REJECT;
        if (isEditable(parent)) return NodeFilter.FILTER_REJECT;
        if (!isVisible(parent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (var n = walker.nextNode(); n; n = walker.nextNode()) out.push(n);
    return out;
  }

  function describe(match, text) {
    if (match.status === "unbound") return "Unbound amount " + text + ": no STARCHART fact accounts for it";
    var fact = factsById.get(match.factId);
    if (match.status === "stale") {
      return "Stale value " + text + " for " + match.factId + (fact ? "; current value is " + fact.value : "");
    }
    return "In sync: " + text + " is " + match.factId;
  }

  function markText(node, facts, options) {
    var text = node.nodeValue;
    var matches = M.findMatches(text, facts, { unbound: Boolean(options.unbound) });
    if (!matches.length) return;
    var parent = node.parentNode;
    var pieces = [];
    var cursor = 0;
    matches.forEach(function (m) {
      if (m.start > cursor) pieces.push(document.createTextNode(text.slice(cursor, m.start)));
      var shown = text.slice(m.start, m.end);
      var mark = el("mark", "starchart-xray starchart-xray--" + m.status, shown);
      mark.setAttribute("data-starchart-status", m.status);
      if (m.factId) mark.setAttribute("data-starchart-fact", m.factId);
      mark.setAttribute("tabindex", "0");
      mark.setAttribute("role", m.factId ? "button" : "note");
      mark.setAttribute("aria-label", describe(m, shown));
      pieces.push(mark);
      marks.push(mark);
      cursor = m.end;
    });
    if (cursor < text.length) pieces.push(document.createTextNode(text.slice(cursor)));
    var fragment = document.createDocumentFragment();
    pieces.forEach(function (p) {
      fragment.appendChild(p);
    });
    parent.insertBefore(fragment, node);
    parent.removeChild(node);
    records.push({ original: node, pieces: pieces });
  }

  function scanMetadata(facts, options) {
    var out = [];
    var add = function (source, text) {
      M.findMatches(text, facts, { unbound: Boolean(options.unbound) }).forEach(function (m) {
        out.push({ source: source, factId: m.factId, status: m.status, text: text.slice(m.start, m.end) });
      });
    };
    META_SELECTORS.forEach(function (selector) {
      var meta = document.querySelector(selector);
      if (meta && meta.content) add(selector.replace(/^meta\[(?:property|name)="([^"]+)"\]$/, "$1"), meta.content);
    });
    if (document.title) add("<title>", document.title);
    Array.prototype.forEach.call(document.querySelectorAll('script[type="application/ld+json"]'), function (s, i) {
      if (s.textContent) add("JSON-LD #" + (i + 1), s.textContent);
    });
    return out;
  }

  // ---------------------------------------------------------------- tooltip

  function ensureTooltip() {
    if (tooltip) return tooltip;
    tooltip = el("div", UI + " starchart-xray-tip");
    tooltip.setAttribute("role", "tooltip");
    tooltip.id = "starchart-xray-tip";
    tooltip.hidden = true;
    document.documentElement.appendChild(tooltip);
    return tooltip;
  }

  function showTip(mark) {
    var tip = ensureTooltip();
    var status = mark.getAttribute("data-starchart-status");
    var factId = mark.getAttribute("data-starchart-fact");
    var fact = factId ? factsById.get(factId) : null;
    tip.textContent = "";
    var badge = el("span", "starchart-xray-badge starchart-xray-badge--" + status, status === "sync" ? "IN SYNC" : status.toUpperCase());
    tip.appendChild(badge);
    if (status === "unbound") {
      tip.appendChild(el("div", "starchart-xray-tip-id", mark.textContent));
      tip.appendChild(el("div", "starchart-xray-tip-row", "No fact in the chart accounts for this amount. Bind it, or it can drift silently."));
    } else {
      tip.appendChild(el("div", "starchart-xray-tip-id", factId));
      var rows = el("dl", "starchart-xray-tip-dl");
      var row = function (k, v, cls) {
        rows.appendChild(el("dt", "", k));
        rows.appendChild(el("dd", cls || "", v));
      };
      row("current", fact ? fact.value : "unknown", "starchart-xray-ok");
      row("page shows", mark.textContent, status === "stale" ? "starchart-xray-bad" : "starchart-xray-ok");
      if (fact && fact.previous !== undefined) row("locked", fact.previous);
      tip.appendChild(rows);
      var linked = fact ? fact.artifacts : [];
      if (linked.length) {
        tip.appendChild(el("div", "starchart-xray-tip-head", "LINKED ARTIFACTS"));
        var ul = el("ul", "starchart-xray-tip-list");
        linked.slice(0, 8).forEach(function (id) {
          var a = artifactsById.get(id);
          var li = el("li", a && a.stale ? "starchart-xray-bad" : "", id + (a && a.stale ? "  · STALE" : ""));
          ul.appendChild(li);
        });
        if (linked.length > 8) ul.appendChild(el("li", "", "+" + (linked.length - 8) + " more"));
        tip.appendChild(ul);
      }
      tip.appendChild(el("div", "starchart-xray-tip-hint", "Click or press Enter to open in STARCHART"));
    }
    tip.hidden = false;
    mark.setAttribute("aria-describedby", tip.id);
    var r = mark.getBoundingClientRect();
    var tw = tip.offsetWidth;
    var th = tip.offsetHeight;
    var left = Math.min(Math.max(8, r.left), window.innerWidth - tw - 8);
    var top = r.bottom + 10;
    if (top + th > window.innerHeight - 8) top = Math.max(8, r.top - th - 10);
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }

  function hideTip() {
    if (tooltip) tooltip.hidden = true;
  }

  function markFrom(target) {
    return target && target.closest ? target.closest("mark.starchart-xray") : null;
  }

  function openFact(mark) {
    var factId = mark.getAttribute("data-starchart-fact");
    if (factId) send({ type: "starchart:open", id: factId }).catch(function () {});
  }

  function onOver(ev) {
    var mark = markFrom(ev.target);
    if (mark) showTip(mark);
  }
  function onOut(ev) {
    var mark = markFrom(ev.target);
    if (mark && !mark.contains(ev.relatedTarget)) hideTip();
  }
  function onClick(ev) {
    var mark = markFrom(ev.target);
    if (!mark || !mark.getAttribute("data-starchart-fact")) return;
    ev.preventDefault();
    ev.stopPropagation();
    openFact(mark);
  }
  function onKey(ev) {
    if (ev.key === "Escape" && hud) {
      hideTip();
      closeHud();
      return;
    }
    var mark = markFrom(ev.target);
    if (mark && (ev.key === "Enter" || ev.key === " ") && mark.getAttribute("data-starchart-fact")) {
      ev.preventDefault();
      ev.stopPropagation();
      openFact(mark);
    }
  }
  function onScroll() {
    hideTip();
  }

  function listen(on) {
    if (on === listening) return;
    listening = on;
    var method = on ? "addEventListener" : "removeEventListener";
    document[method]("mouseover", onOver, true);
    document[method]("mouseout", onOut, true);
    document[method]("focusin", onOver, true);
    document[method]("focusout", onOut, true);
    document[method]("click", onClick, true);
    document[method]("keydown", onKey, true);
    window[method]("scroll", onScroll, true);
  }

  // ---------------------------------------------------------------- HUD

  function closeHud() {
    if (hud) hud.remove();
    hud = null;
  }

  function stat(label, value, cls) {
    var box = el("div", "starchart-xray-stat " + cls);
    box.appendChild(el("span", "starchart-xray-stat-n", String(value)));
    box.appendChild(el("span", "starchart-xray-stat-l", label));
    return box;
  }

  function button(label, onClick, cls) {
    var b = el("button", "starchart-xray-btn " + (cls || ""), label);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }

  function renderHud(summary) {
    var fresh = !hud;
    var pos = hud ? { left: hud.style.left, top: hud.style.top } : null;
    closeHud();
    hud = el("section", UI + " starchart-xray-hud");
    hud.setAttribute("role", "dialog");
    hud.setAttribute("aria-label", "STARCHART X-Ray results");
    if (pos && pos.left) {
      hud.style.left = pos.left;
      hud.style.top = pos.top;
      hud.style.right = "auto";
    }

    var bar = el("header", "starchart-xray-bar");
    var title = el("div", "starchart-xray-title");
    title.appendChild(el("span", "starchart-xray-star", "★"));
    title.appendChild(el("span", "", "X-RAY"));
    title.appendChild(el("span", "starchart-xray-project", payload ? payload.name : ""));
    bar.appendChild(title);
    var close = button("×", function () {
      hideTip();
      closeHud();
    }, "starchart-xray-close");
    close.setAttribute("aria-label", "Close X-Ray panel (Escape)");
    bar.appendChild(close);
    hud.appendChild(bar);
    makeDraggable(hud, bar);

    var body = el("div", "starchart-xray-body");
    var stats = el("div", "starchart-xray-stats");
    stats.appendChild(stat("in sync", summary.sync, "starchart-xray-stat--sync"));
    stats.appendChild(stat("stale", summary.stale, "starchart-xray-stat--stale"));
    stats.appendChild(stat("unbound", lastOptions.unbound ? summary.unbound : "–", "starchart-xray-stat--unbound"));
    body.appendChild(stats);

    if (summary.artifacts.length) {
      body.appendChild(el("div", "starchart-xray-head", "THIS PAGE IS"));
      var al = el("ul", "starchart-xray-list");
      summary.artifacts.forEach(function (a) {
        al.appendChild(el("li", a.stale ? "starchart-xray-bad" : "starchart-xray-ok", a.id + (a.stale ? " · STALE" : " · in sync")));
      });
      body.appendChild(al);
    }

    var staleMarks = marks.filter(function (m) {
      return m.getAttribute("data-starchart-status") === "stale";
    });
    if (staleMarks.length) {
      body.appendChild(el("div", "starchart-xray-head", "STALE ON THIS PAGE"));
      var sl = el("ul", "starchart-xray-list");
      staleMarks.slice(0, 12).forEach(function (m) {
        var li = el("li");
        var jump = button(m.textContent + " → " + m.getAttribute("data-starchart-fact"), function () {
          m.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
          m.focus({ preventScroll: true });
        }, "starchart-xray-link starchart-xray-bad");
        li.appendChild(jump);
        sl.appendChild(li);
      });
      if (staleMarks.length > 12) sl.appendChild(el("li", "", "+" + (staleMarks.length - 12) + " more"));
      body.appendChild(sl);
    }

    if (findings.length) {
      body.appendChild(el("div", "starchart-xray-head", "METADATA"));
      var ml = el("ul", "starchart-xray-list");
      findings.slice(0, 12).forEach(function (f) {
        var cls = f.status === "stale" ? "starchart-xray-bad" : f.status === "sync" ? "starchart-xray-ok" : "starchart-xray-muted";
        ml.appendChild(el("li", cls, f.source + ": " + f.text + (f.factId ? " → " + f.factId : "") + " (" + f.status + ")"));
      });
      body.appendChild(ml);
    }

    if (!summary.sync && !summary.stale && !findings.length) {
      body.appendChild(el("p", "starchart-xray-muted", "No fact values found on this page."));
    }

    var toggleRow = el("label", "starchart-xray-toggle");
    var box = el("input");
    box.type = "checkbox";
    box.checked = Boolean(lastOptions.unbound);
    box.addEventListener("change", function () {
      scan({ unbound: box.checked }).catch(function () {});
    });
    toggleRow.appendChild(box);
    toggleRow.appendChild(el("span", "", "Mark unbound prices"));
    body.appendChild(toggleRow);

    var actions = el("div", "starchart-xray-actions");
    actions.appendChild(button("RESCAN", function () {
      scan(lastOptions).catch(function () {});
    }, "starchart-xray-primary"));
    actions.appendChild(button("CLEAR", function () {
      clear();
    }));
    actions.appendChild(button("OPEN CHART", function () {
      send({ type: "starchart:open", id: "" }).catch(function () {});
    }));
    body.appendChild(actions);
    hud.appendChild(body);
    document.documentElement.appendChild(hud);
    if (fresh) close.focus({ preventScroll: true });
  }

  function renderError(message) {
    closeHud();
    hud = el("section", UI + " starchart-xray-hud");
    hud.setAttribute("role", "alertdialog");
    hud.setAttribute("aria-label", "STARCHART X-Ray error");
    var bar = el("header", "starchart-xray-bar");
    var title = el("div", "starchart-xray-title");
    title.appendChild(el("span", "starchart-xray-star", "★"));
    title.appendChild(el("span", "", "X-RAY"));
    bar.appendChild(title);
    var close = button("×", closeHud, "starchart-xray-close");
    close.setAttribute("aria-label", "Close X-Ray panel (Escape)");
    bar.appendChild(close);
    hud.appendChild(bar);
    makeDraggable(hud, bar);
    var body = el("div", "starchart-xray-body");
    body.appendChild(el("p", "starchart-xray-bad", message));
    body.appendChild(el("p", "starchart-xray-muted", "Start the server with: starchart serve"));
    hud.appendChild(body);
    document.documentElement.appendChild(hud);
    close.focus({ preventScroll: true });
  }

  function makeDraggable(panel, handle) {
    handle.addEventListener("pointerdown", function (ev) {
      if (ev.button !== 0 || (ev.target && ev.target.closest("button"))) return;
      var rect = panel.getBoundingClientRect();
      var dx = ev.clientX - rect.left;
      var dy = ev.clientY - rect.top;
      handle.setPointerCapture(ev.pointerId);
      var move = function (e) {
        var left = Math.min(Math.max(0, e.clientX - dx), window.innerWidth - rect.width);
        var top = Math.min(Math.max(0, e.clientY - dy), window.innerHeight - 40);
        panel.style.left = left + "px";
        panel.style.top = top + "px";
        panel.style.right = "auto";
      };
      var up = function () {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    });
  }

  // ---------------------------------------------------------------- scan / clear

  function unmark() {
    for (var i = records.length - 1; i >= 0; i--) {
      var r = records[i];
      var first = r.pieces[0];
      if (first && first.parentNode) {
        first.parentNode.insertBefore(r.original, first);
        r.pieces.forEach(function (p) {
          if (p.parentNode) p.parentNode.removeChild(p);
        });
      }
    }
    var count = marks.length;
    records = [];
    marks = [];
    return count;
  }

  function clear() {
    var cleared = unmark();
    hideTip();
    closeHud();
    if (tooltip) tooltip.remove();
    tooltip = null;
    findings = [];
    listen(false);
    return { cleared: cleared };
  }

  async function scan(options) {
    lastOptions = { unbound: Boolean(options && options.unbound) };
    unmark();
    hideTip();
    try {
      payload = await send({ type: "starchart:xray" });
    } catch (error) {
      renderError(error.message);
      return { error: error.message };
    }
    factsById = new Map(payload.facts.map(function (f) {
      return [f.id, f];
    }));
    artifactsById = new Map(payload.artifacts.map(function (a) {
      return [a.id, a];
    }));
    visibility = new WeakMap();
    var facts = payload.facts;
    collectTextNodes(document.body || document.documentElement).forEach(function (node) {
      markText(node, facts, lastOptions);
    });
    findings = scanMetadata(facts, lastOptions);
    var summary = { sync: 0, stale: 0, unbound: 0, meta: findings.length, artifacts: [] };
    marks.forEach(function (m) {
      summary[m.getAttribute("data-starchart-status")]++;
    });
    summary.artifacts = payload.artifacts
      .filter(function (a) {
        return a.urls.some(function (u) {
          return M.urlMatches(u, location.href);
        });
      })
      .map(function (a) {
        return { id: a.id, stale: a.stale };
      });
    listen(true);
    renderHud(summary);
    return summary;
  }

  globalThis.StarchartXray = { scan: scan, clear: clear };
})();
