/*
 * STARCHART viewer: the literal star chart. Three horizontal bands (WORLD, FACTS, CODE),
 * a band-constrained force layout, canvas rendering, search, details and IMPACT mode.
 * Runs as a classic inline script after impact-core.js; reads its data from the
 * #starchart-data JSON element. All DOM text goes through textContent, never innerHTML.
 */
(function () {
  "use strict";

  var DATA = JSON.parse(document.getElementById("starchart-data").textContent);
  var Impact = window.StarchartImpact;
  var CFG = DATA.impact;

  // ------------------------------------------------------------------ constants

  var LAYER_COLOR = { world: "#ff1493", fact: "#ffd000", code: "#00ff41" };
  var BAND_ORDER = ["world", "fact", "code"];
  var BAND_LABEL = { world: "WORLD", fact: "FACTS", code: "CODE" };
  var CLASS_COLOR = {
    auto: "#00ff41",
    review: "#ffd000",
    manual: "#ff8c00",
    retire: "#8a8a99",
    break: "#ff2d55",
    code: "#00d0ff",
    test: "#b388ff",
    info: "#c9c9d6",
  };
  var CLASS_ORDER = ["break", "manual", "review", "auto", "code", "test", "retire", "info"];
  var CLASS_LABEL = {
    break: "break",
    manual: "manual",
    review: "review",
    auto: "auto-fix",
    code: "code change",
    test: "tests to run",
    retire: "retire",
    info: "also affected",
  };
  var CODE_EDGES = { imports: 1, references: 1, dependsOn: 1, tests: 1, serves: 1, readsEnv: 1, readsFlag: 1, contains: 1 };
  var CAT_COLOR = { code: "#00ff41", bridge: "#00d0ff", fact: "#ffd000", world: "#ff1493" };
  var BRIDGE = {};
  CFG.bridgeEdges.forEach(function (t) {
    BRIDGE[t] = 1;
  });
  var LOW_CONFIDENCE = 0.5;
  var MAX_LINKS = 200;
  var MAX_LABELS = 320;
  var MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // ------------------------------------------------------------------ graph data

  var nodes = DATA.graph.nodes;
  var N = nodes.length;
  var byId = new Map();
  for (var ni = 0; ni < N; ni++) byId.set(nodes[ni].id, ni);

  function edgeCategory(type) {
    if (BRIDGE[type]) return "bridge";
    if (CODE_EDGES[type]) return "code";
    if (type === "partOf") return "fact";
    return "world";
  }

  var edges = [];
  var edgeTypeCount = {};
  var deg = new Int32Array(N);
  DATA.graph.edges.forEach(function (e) {
    var s = byId.get(e.from);
    var t = byId.get(e.to);
    if (s === undefined || t === undefined) return;
    edges.push({ s: s, t: t, type: e.type, cat: edgeCategory(e.type), conf: e.confidence === undefined ? 1 : e.confidence });
    edgeTypeCount[e.type] = (edgeTypeCount[e.type] || 0) + 1;
    deg[s]++;
    deg[t]++;
  });
  var adj = [];
  for (var ai = 0; ai < N; ai++) adj.push([]);
  edges.forEach(function (e, k) {
    adj[e.s].push(k);
    adj[e.t].push(k);
  });

  var radius = new Float32Array(N);
  var hasBridge = new Uint8Array(N);
  for (var ri = 0; ri < N; ri++) {
    var base = nodes[ri].layer === "world" ? 5 : nodes[ri].layer === "fact" ? 4 : 3;
    radius[ri] = base + Math.min(14, Math.sqrt(deg[ri]) * 1.7);
  }
  edges.forEach(function (e) {
    if (e.cat === "bridge") {
      hasBridge[e.s] = 1;
      hasBridge[e.t] = 1;
    }
  });

  var staleSet = new Set(DATA.stale);
  var lockFacts = DATA.lockFacts || {};
  var impactIndex = Impact.createIndex(DATA.graph);

  // ------------------------------------------------------------------ view state

  var state = {
    layers: { world: true, fact: true, code: true },
    showAllCode: false,
    impact: false,
    hiddenTypes: {},
    selected: -1,
    hovered: -1,
    history: [],
    impactResult: null,
    impactMap: null,
    impactHops: [],
    forced: new Uint8Array(N),
  };
  var cam = { k: 1, tx: 0, ty: 0 };
  var userMoved = false;

  var x = new Float64Array(N);
  var y = new Float64Array(N);
  var vx = new Float64Array(N);
  var vy = new Float64Array(N);
  var placed = new Uint8Array(N);
  var inLayout = new Uint8Array(N);
  var visible = new Uint8Array(N);
  var bands = {};
  var worldWidth = 1400;

  // ------------------------------------------------------------------ DOM

  var $ = function (id) {
    return document.getElementById(id);
  };
  var canvas = $("chart");
  var ctx = canvas.getContext("2d");
  var stage = $("stage");
  var tooltip = $("tooltip");
  var statusEl = $("status");
  var panel = $("panel");
  var panelBody = $("panel-body");
  var panelBack = $("panel-back");
  var searchInput = $("search");
  var resultsEl = $("search-results");
  var announceEl = $("announce");
  var sky = $("sky");
  var skyCtx = sky.getContext("2d");
  var dpr = Math.max(1, window.devicePixelRatio || 1);
  var viewW = 0;
  var viewH = 0;

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === undefined || v === null || v === false) return;
        if (k === "text") el.textContent = v;
        else if (k === "className") el.className = v;
        else if (k === "onclick") el.addEventListener("click", v);
        else if (k === "bg") el.style.background = v;
        else if (k === "borderColor") el.style.borderLeftColor = v;
        else el.setAttribute(k, v === true ? "" : String(v));
      });
    }
    (children || []).forEach(function (c) {
      if (c === null || c === undefined || c === false) return;
      el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return el;
  }

  function fmt(n) {
    return n.toLocaleString("en-US");
  }

  function announce(text) {
    announceEl.textContent = "";
    window.setTimeout(function () {
      announceEl.textContent = text;
    }, 30);
  }

  function preview(value, max) {
    var s = typeof value === "string" ? value : JSON.stringify(value);
    if (s === undefined) return "";
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }

  function shortLabel(n) {
    var s = n.label || n.id.replace(/^[a-z]+:/, "");
    return s.length > 34 ? s.slice(0, 33) + "…" : s;
  }

  // ------------------------------------------------------------------ visibility

  function baseVisible(i) {
    var n = nodes[i];
    if (state.forced[i]) return true;
    if (n.kind !== "file" && n.kind !== "symbol") return true;
    if (state.showAllCode) return true;
    return n.kind === "symbol" && hasBridge[i] === 1;
  }

  function computeVisibility() {
    for (var i = 0; i < N; i++) visible[i] = baseVisible(i) && state.layers[nodes[i].layer] ? 1 : 0;
  }

  function isEdgeShown(e) {
    return visible[e.s] && visible[e.t] && !state.hiddenTypes[e.type];
  }

  // ------------------------------------------------------------------ layout

  function hashString(s) {
    var hsh = 2166136261;
    for (var i = 0; i < s.length; i++) {
      hsh ^= s.charCodeAt(i);
      hsh = Math.imul(hsh, 16777619);
    }
    return hsh >>> 0;
  }

  function rand01(seed) {
    var t = (seed + 0x6d2b79f5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function computeBands() {
    var counts = { world: 0, fact: 0, code: 0 };
    var total = 0;
    for (var i = 0; i < N; i++) {
      if (!inLayout[i]) continue;
      counts[nodes[i].layer]++;
      total++;
    }
    worldWidth = Math.max(1400, Math.min(14000, Math.sqrt(total) * 70));
    var spacing = 48;
    var top = 0;
    BAND_ORDER.forEach(function (layer) {
      var height = Math.max(260, Math.min(9000, (counts[layer] * spacing * spacing) / worldWidth));
      bands[layer] = { top: top, height: height, center: top + height / 2, count: counts[layer] };
      top += height + 110;
    });
  }

  function placeNew(list) {
    list.forEach(function (i) {
      var b = bands[nodes[i].layer];
      var seed = hashString(nodes[i].id);
      x[i] = rand01(seed) * worldWidth;
      y[i] = b.top + 16 + rand01(seed ^ 0x9e3779b9) * (b.height - 32);
    });
    // Two barycentric sweeps pull new stars toward what they connect to, across bands.
    for (var pass = 0; pass < 2; pass++) {
      list.forEach(function (i) {
        var sum = 0;
        var cnt = 0;
        adj[i].forEach(function (k) {
          var e = edges[k];
          var o = e.s === i ? e.t : e.s;
          if (!inLayout[o] && !state.forced[o]) return;
          if (!placed[o] && pass === 0) return;
          sum += x[o];
          cnt++;
        });
        if (cnt) x[i] = 0.35 * x[i] + 0.65 * (sum / cnt) + (rand01(hashString(nodes[i].id) + pass) - 0.5) * 40;
      });
    }
    list.forEach(function (i) {
      placed[i] = 1;
      vx[i] = 0;
      vy[i] = 0;
    });
  }

  var gridStart = new Int32Array(0);
  var gridItems = new Int32Array(0);
  var cellOf = new Int32Array(0);

  function tick(list, layoutEdges, alpha) {
    var m = list.length;
    var R = 110;
    var R2 = R * R;
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    var a, i, j;
    for (a = 0; a < m; a++) {
      i = list[a];
      if (x[i] < minX) minX = x[i];
      if (x[i] > maxX) maxX = x[i];
      if (y[i] < minY) minY = y[i];
      if (y[i] > maxY) maxY = y[i];
    }
    var cell = R;
    var gw = Math.floor((maxX - minX) / cell) + 1;
    var gh = Math.floor((maxY - minY) / cell) + 1;
    while (gw * gh > 4000000) {
      cell *= 2;
      gw = Math.floor((maxX - minX) / cell) + 1;
      gh = Math.floor((maxY - minY) / cell) + 1;
    }
    var cells = gw * gh;
    if (gridStart.length < cells + 1) gridStart = new Int32Array(cells + 1);
    else gridStart.fill(0, 0, cells + 1);
    if (gridItems.length < m) {
      gridItems = new Int32Array(m);
      cellOf = new Int32Array(m);
    }
    for (a = 0; a < m; a++) {
      i = list[a];
      var c = Math.floor((y[i] - minY) / cell) * gw + Math.floor((x[i] - minX) / cell);
      cellOf[a] = c;
      gridStart[c + 1]++;
    }
    for (var s = 0; s < cells; s++) gridStart[s + 1] += gridStart[s];
    var fill = gridStart.slice(0, cells);
    for (a = 0; a < m; a++) gridItems[fill[cellOf[a]]++] = list[a];

    // Repulsion between nearby stars (grid neighbourhood, each pair once).
    var rep = 14 * alpha;
    for (a = 0; a < m; a++) {
      i = list[a];
      var cx = Math.floor((x[i] - minX) / cell);
      var cy = Math.floor((y[i] - minY) / cell);
      for (var oy = -1; oy <= 1; oy++) {
        var yy = cy + oy;
        if (yy < 0 || yy >= gh) continue;
        for (var ox = -1; ox <= 1; ox++) {
          var xx = cx + ox;
          if (xx < 0 || xx >= gw) continue;
          var cc = yy * gw + xx;
          for (var q = gridStart[cc]; q < gridStart[cc + 1]; q++) {
            j = gridItems[q];
            if (j <= i) continue;
            var dx = x[i] - x[j];
            var dy = y[i] - y[j];
            var d2 = dx * dx + dy * dy;
            if (d2 >= R2) continue;
            if (d2 < 0.01) {
              dx = rand01(i * 31 + j) - 0.5;
              dy = rand01(j * 17 + i) - 0.5;
              d2 = dx * dx + dy * dy + 0.01;
            }
            var d = Math.sqrt(d2);
            var push = 1 - d / R;
            var f = (rep * push * push * (1 + (radius[i] + radius[j]) / 24)) / d;
            vx[i] += dx * f;
            vy[i] += dy * f;
            vx[j] -= dx * f;
            vy[j] -= dy * f;
          }
        }
      }
    }

    // Edge springs: full 2D inside a band, x-only across bands (bands hold y).
    for (var k = 0; k < layoutEdges.length; k++) {
      var e = edges[layoutEdges[k]];
      var p = e.s;
      var t = e.t;
      var stiff = 1 / Math.sqrt(Math.max(1, Math.min(deg[p], deg[t])));
      var ex = x[t] - x[p];
      if (nodes[p].layer === nodes[t].layer) {
        var ey = y[t] - y[p];
        var dist = Math.sqrt(ex * ex + ey * ey) || 1;
        var fs = ((dist - 70) / dist) * 0.05 * alpha * stiff;
        vx[p] += ex * fs;
        vy[p] += ey * fs;
        vx[t] -= ex * fs;
        vy[t] -= ey * fs;
      } else {
        var fx = ex * 0.018 * alpha * stiff;
        vx[p] += fx;
        vx[t] -= fx;
      }
    }

    // Band spring + gentle x gravity, then integrate with damping and clamp to the band.
    var mid = worldWidth / 2;
    for (a = 0; a < m; a++) {
      i = list[a];
      var b = bands[nodes[i].layer];
      vy[i] += (b.center - y[i]) * 0.006 * alpha;
      vx[i] += (mid - x[i]) * 0.0012 * alpha;
      vx[i] *= 0.55;
      vy[i] *= 0.55;
      if (vx[i] > 40) vx[i] = 40;
      else if (vx[i] < -40) vx[i] = -40;
      if (vy[i] > 40) vy[i] = 40;
      else if (vy[i] < -40) vy[i] = -40;
      x[i] += vx[i];
      y[i] += vy[i];
      var lo = b.top + 14;
      var hi = b.top + b.height - 14;
      if (y[i] < lo) y[i] = lo;
      else if (y[i] > hi) y[i] = hi;
    }
  }

  var layoutJob = 0;

  /** Runs the band-constrained force layout in frame-sized slices. */
  function runLayout(warm) {
    var job = ++layoutJob;
    var list = [];
    var fresh = [];
    for (var i = 0; i < N; i++) {
      inLayout[i] = baseVisible(i) ? 1 : 0;
      if (!inLayout[i]) continue;
      list.push(i);
      if (!placed[i]) fresh.push(i);
    }
    var oldMid = worldWidth / 2;
    computeBands();
    // Keep already-charted stars centred when the chart widens or narrows.
    var shift = worldWidth / 2 - oldMid;
    if (shift !== 0) for (var p = 0; p < N; p++) if (placed[p]) x[p] += shift;
    placeNew(fresh);
    var layoutEdges = [];
    edges.forEach(function (e, k) {
      if (inLayout[e.s] && inLayout[e.t]) layoutEdges.push(k);
    });
    var m = list.length;
    var ticks = m <= 1000 ? 320 : m <= 3000 ? 220 : 150;
    if (warm) ticks = Math.round(ticks * 0.6);
    var alpha0 = warm ? 0.6 : 1;
    var done = 0;
    var listArr = Int32Array.from(list);
    var animate = !reduceMotion.matches;
    setStatus("CHARTING " + fmt(m) + " STARS…");
    if (!userMoved && !warm) fitBands();

    function step() {
      if (job !== layoutJob) return;
      var start = performance.now();
      while (done < ticks && performance.now() - start < 14) {
        var alpha = alpha0 * Math.pow(0.02, done / ticks);
        tick(listArr, layoutEdges, alpha);
        done++;
      }
      computeVisibility();
      if (animate) requestRender();
      if (done < ticks) {
        schedule(step);
        return;
      }
      setStatus("");
      if (!userMoved && !warm) fit(false);
      requestRender();
      onLayoutDone();
    }
    schedule(step);
  }

  /** Next animation frame while visible; a macrotask when hidden, so layout still finishes in background tabs. */
  function schedule(fn) {
    if (document.hidden) window.setTimeout(fn, 0);
    else requestAnimationFrame(fn);
  }

  var layoutDoneCallbacks = [];
  function onLayoutDone() {
    var cbs = layoutDoneCallbacks;
    layoutDoneCallbacks = [];
    cbs.forEach(function (cb) {
      cb();
    });
  }

  /** Makes a hidden star visible without a relayout: placed next to what it connects to. */
  function reveal(i) {
    var n = nodes[i];
    var changed = false;
    if (!state.layers[n.layer]) {
      state.layers[n.layer] = true;
      syncChips();
      changed = true;
    }
    if (!baseVisible(i)) {
      state.forced[i] = 1;
      changed = true;
      if (!placed[i]) {
        var b = bands[n.layer];
        var sum = 0;
        var cnt = 0;
        adj[i].forEach(function (k) {
          var e = edges[k];
          var o = e.s === i ? e.t : e.s;
          if (placed[o]) {
            sum += x[o];
            cnt++;
          }
        });
        var seed = hashString(n.id);
        x[i] = (cnt ? sum / cnt : rand01(seed) * worldWidth) + (rand01(seed + 1) - 0.5) * 60;
        y[i] = b.top + 16 + rand01(seed + 2) * (b.height - 32);
        placed[i] = 1;
      }
    }
    if (changed) computeVisibility();
  }

  // ------------------------------------------------------------------ camera

  function toScreenX(wx) {
    return wx * cam.k + cam.tx;
  }
  function toScreenY(wy) {
    return wy * cam.k + cam.ty;
  }

  function setView(bx0, by0, bx1, by1) {
    var pad = 60;
    var w = Math.max(1, bx1 - bx0);
    var hgt = Math.max(1, by1 - by0);
    var k = Math.min((viewW - pad * 2) / w, (viewH - pad * 2) / hgt);
    cam.k = Math.max(0.02, Math.min(3, k));
    cam.tx = viewW / 2 - ((bx0 + bx1) / 2) * cam.k;
    cam.ty = viewH / 2 - ((by0 + by1) / 2) * cam.k;
  }

  function fitBands() {
    var last = bands.code;
    setView(0, 0, worldWidth, last.top + last.height);
    requestRender();
  }

  function fit(announceIt) {
    var x0 = Infinity;
    var y0 = Infinity;
    var x1 = -Infinity;
    var y1 = -Infinity;
    for (var i = 0; i < N; i++) {
      if (!visible[i]) continue;
      if (x[i] < x0) x0 = x[i];
      if (x[i] > x1) x1 = x[i];
      if (y[i] < y0) y0 = y[i];
      if (y[i] > y1) y1 = y[i];
    }
    if (x0 === Infinity) {
      fitBands();
      return;
    }
    var top = bands.world ? Math.min(y0, bands.world.top) : y0;
    var last = bands.code;
    var bottom = last ? Math.max(y1, last.top + last.height) : y1;
    setView(x0 - 40, top, x1 + 40, bottom);
    requestRender();
    if (announceIt) announce("Fitted chart to screen");
  }

  function zoomAt(factor, sx, sy) {
    var k = Math.max(0.02, Math.min(8, cam.k * factor));
    var real = k / cam.k;
    cam.tx = sx - (sx - cam.tx) * real;
    cam.ty = sy - (sy - cam.ty) * real;
    cam.k = k;
    userMoved = true;
    requestRender();
  }

  var tween = 0;
  function centerOn(i) {
    var targetK = Math.max(cam.k, 0.7);
    var tx1 = viewW / 2 - x[i] * targetK;
    var ty1 = viewH / 2 - y[i] * targetK;
    userMoved = true;
    if (reduceMotion.matches) {
      cam.k = targetK;
      cam.tx = tx1;
      cam.ty = ty1;
      requestRender();
      return;
    }
    var from = { k: cam.k, tx: cam.tx, ty: cam.ty };
    var start = performance.now();
    var id = ++tween;
    function frame(now) {
      if (id !== tween) return;
      var p = Math.min(1, (now - start) / 320);
      var e = 1 - Math.pow(1 - p, 3);
      cam.k = from.k + (targetK - from.k) * e;
      cam.tx = from.tx + (tx1 - from.tx) * e;
      cam.ty = from.ty + (ty1 - from.ty) * e;
      requestRender();
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  /** Whether star i sits comfortably inside the view (clear of the edges and the legend corner). */
  function isOnScreen(i) {
    var sx = toScreenX(x[i]);
    var sy = toScreenY(y[i]);
    var margin = Math.min(80, viewW * 0.1);
    var right = viewW - Math.min(260, viewW * 0.3);
    return sx > margin && sy > margin && sx < right && sy < viewH - margin;
  }

  // ------------------------------------------------------------------ rendering

  var renderQueued = false;
  var pulseTimer = 0;

  function requestRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(function (now) {
      renderQueued = false;
      draw(now);
    });
  }

  function hasVisibleStale() {
    for (var i = 0; i < N; i++) if (visible[i] && staleSet.has(nodes[i].id)) return true;
    return false;
  }

  function withAlpha(hex, a) {
    var r = parseInt(hex.slice(1, 3), 16);
    var g = parseInt(hex.slice(3, 5), 16);
    var b = parseInt(hex.slice(5, 7), 16);
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }

  function draw(now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, viewW, viewH);
    drawBands();
    drawEdges();
    drawNodes(now);
    if (!pulseTimer && !reduceMotion.matches && hasVisibleStale()) {
      pulseTimer = window.setTimeout(function () {
        pulseTimer = 0;
        requestRender();
      }, 33);
    }
  }

  function drawBands() {
    BAND_ORDER.forEach(function (layer) {
      var b = bands[layer];
      if (!b) return;
      var sy0 = toScreenY(b.top);
      var sy1 = toScreenY(b.top + b.height);
      if (sy1 < 0 || sy0 > viewH) return;
      var on = state.layers[layer];
      ctx.fillStyle = on ? "rgba(13,13,16,0.62)" : "rgba(13,13,16,0.25)";
      ctx.fillRect(0, sy0, viewW, sy1 - sy0);
      ctx.strokeStyle = withAlpha(LAYER_COLOR[layer], on ? 0.55 : 0.2);
      ctx.lineWidth = 2;
      ctx.setLineDash([10, 8]);
      ctx.beginPath();
      ctx.moveTo(0, Math.round(sy0) + 0.5);
      ctx.lineTo(viewW, Math.round(sy0) + 0.5);
      ctx.moveTo(0, Math.round(sy1) + 0.5);
      ctx.lineTo(viewW, Math.round(sy1) + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
      var ly = Math.max(sy0 + 24, Math.min(sy1 - 10, (sy0 + sy1) / 2));
      ctx.font = "900 15px " + MONO;
      ctx.textBaseline = "alphabetic";
      ctx.lineJoin = "round";
      ctx.lineWidth = 5;
      ctx.strokeStyle = "#000";
      var label = BAND_LABEL[layer];
      ctx.strokeText(label, 16, ly);
      ctx.fillStyle = on ? LAYER_COLOR[layer] : "#8a8a99";
      ctx.fillText(label, 16, ly);
      ctx.font = "700 11px " + MONO;
      var sub = fmt(b.count) + (on ? "" : " · hidden");
      ctx.lineWidth = 4;
      ctx.strokeText(sub, 16, ly + 16);
      ctx.fillStyle = "#8a8a99";
      ctx.fillText(sub, 16, ly + 16);
    });
  }

  function drawEdges() {
    var sel = state.selected;
    var impactOn = state.impact && state.impactMap;
    var baseAlpha = edges.length > 8000 ? 0.07 : edges.length > 2000 ? 0.12 : 0.22;
    if (impactOn) baseAlpha = 0.035;
    else if (sel >= 0) baseAlpha *= 0.5;
    var paths = { code: new Path2D(), bridge: new Path2D(), fact: new Path2D(), world: new Path2D() };
    var hot = [];
    for (var k = 0; k < edges.length; k++) {
      var e = edges[k];
      if (!isEdgeShown(e)) continue;
      if (!impactOn && sel >= 0 && (e.s === sel || e.t === sel)) {
        hot.push(e);
        continue;
      }
      var p = paths[e.cat];
      p.moveTo(toScreenX(x[e.s]), toScreenY(y[e.s]));
      p.lineTo(toScreenX(x[e.t]), toScreenY(y[e.t]));
    }
    ctx.lineWidth = 1;
    Object.keys(paths).forEach(function (cat) {
      ctx.strokeStyle = withAlpha(CAT_COLOR[cat], baseAlpha);
      ctx.stroke(paths[cat]);
    });
    ctx.lineWidth = 2;
    hot.forEach(function (e) {
      ctx.strokeStyle = withAlpha(CAT_COLOR[e.cat], 0.9);
      ctx.beginPath();
      ctx.moveTo(toScreenX(x[e.s]), toScreenY(y[e.s]));
      ctx.lineTo(toScreenX(x[e.t]), toScreenY(y[e.t]));
      ctx.stroke();
    });
    if (impactOn) drawImpactHops();
  }

  function drawImpactHops() {
    state.impactHops.forEach(function (hop) {
      var a = hop.a;
      var b = hop.b;
      if (!visible[a] || !visible[b]) return;
      var x0 = toScreenX(x[a]);
      var y0 = toScreenY(y[a]);
      var x1 = toScreenX(x[b]);
      var y1 = toScreenY(y[b]);
      ctx.lineWidth = 5;
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = hop.color;
      ctx.stroke();
      // arrowhead at the midpoint shows the direction impact flows
      var mx = (x0 + x1) / 2;
      var my = (y0 + y1) / 2;
      var ang = Math.atan2(y1 - y0, x1 - x0);
      ctx.fillStyle = hop.color;
      ctx.beginPath();
      ctx.moveTo(mx + Math.cos(ang) * 7, my + Math.sin(ang) * 7);
      ctx.lineTo(mx + Math.cos(ang + 2.5) * 7, my + Math.sin(ang + 2.5) * 7);
      ctx.lineTo(mx + Math.cos(ang - 2.5) * 7, my + Math.sin(ang - 2.5) * 7);
      ctx.closePath();
      ctx.fill();
    });
  }

  function starPath(cx, cy, r) {
    var outer = r * 1.9;
    var inner = r * 0.55;
    ctx.beginPath();
    for (var p = 0; p < 8; p++) {
      var rad = p % 2 === 0 ? outer : inner;
      var ang = (Math.PI / 4) * p - Math.PI / 2;
      var px = cx + Math.cos(ang) * rad;
      var py = cy + Math.sin(ang) * rad;
      if (p === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
  }

  function drawNodes(now) {
    var sel = state.selected;
    var impactOn = state.impact && state.impactMap;
    var neighbour = null;
    if (!impactOn && sel >= 0) {
      neighbour = new Set();
      adj[sel].forEach(function (k) {
        neighbour.add(edges[k].s);
        neighbour.add(edges[k].t);
      });
    }
    var pulse = reduceMotion.matches ? 0.35 : (now % 1600) / 1600;
    var labels = [];
    var zoomR = Math.max(0.35, Math.min(2.2, cam.k));
    for (var i = 0; i < N; i++) {
      if (!visible[i]) continue;
      var sx = toScreenX(x[i]);
      var sy = toScreenY(y[i]);
      var sr = Math.max(1.6, radius[i] * zoomR * 0.8);
      if (sx < -40 || sy < -40 || sx > viewW + 40 || sy > viewH + 40) continue;
      var n = nodes[i];
      var color = LAYER_COLOR[n.layer];
      var alpha = 1;
      var item = null;
      var isSeed = impactOn && i === sel;
      if (impactOn) {
        item = state.impactMap.get(n.id);
        if (item) color = CLASS_COLOR[item.class];
        else if (!isSeed) alpha = 0.14;
      } else if (neighbour && !neighbour.has(i)) {
        alpha = 0.4;
      }
      ctx.globalAlpha = alpha;
      var big = sr >= 4.5;
      if (big) {
        // cel-shaded hard shadow, flat fill, thick ink outline
        ctx.fillStyle = "#000";
        if (sr >= 7) starPath(sx + 2.5, sy + 2.5, sr);
        else {
          ctx.beginPath();
          ctx.arc(sx + 2, sy + 2, sr, 0, Math.PI * 2);
        }
        ctx.fill();
      }
      ctx.fillStyle = isSeed ? "#ff1493" : color;
      if (sr >= 7) starPath(sx, sy, sr);
      else {
        ctx.beginPath();
        ctx.arc(sx, sy, sr, 0, Math.PI * 2);
      }
      ctx.fill();
      if (big) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = "#000";
        ctx.stroke();
      }
      if (staleSet.has(n.id)) {
        var ringR = sr + 4 + pulse * 7;
        ctx.globalAlpha = alpha * (reduceMotion.matches ? 0.95 : 1 - pulse * 0.85);
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = "#ff2d55";
        ctx.beginPath();
        ctx.arc(sx, sy, ringR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = alpha;
      }
      if (i === sel || i === state.hovered) {
        ctx.globalAlpha = 1;
        ctx.lineWidth = 3;
        ctx.strokeStyle = i === sel ? "#ff1493" : "#f5f5f5";
        ctx.beginPath();
        ctx.arc(sx, sy, sr * (sr >= 7 ? 1.9 : 1) + 5, 0, Math.PI * 2);
        ctx.stroke();
        if (i === sel) {
          ctx.strokeStyle = "#000";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(sx, sy, sr * (sr >= 7 ? 1.9 : 1) + 7.5, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      var wantLabel =
        i === sel ||
        i === state.hovered ||
        (impactOn && (item || isSeed) && labels.length < MAX_LABELS) ||
        (!impactOn && neighbour && neighbour.has(i) && labels.length < MAX_LABELS) ||
        (!impactOn && (cam.k >= 1.3 || (sr >= 8 && cam.k >= 0.45)) && labels.length < MAX_LABELS);
      if (wantLabel) labels.push({ i: i, sx: sx, sy: sy, sr: sr, color: item ? CLASS_COLOR[item.class] : "#f5f5f5", alpha: alpha });
    }
    ctx.font = "700 11px " + MONO;
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    labels.forEach(function (l) {
      var text = shortLabel(nodes[l.i]);
      var lx = l.sx + l.sr * (l.sr >= 7 ? 1.9 : 1) + 6;
      ctx.globalAlpha = Math.max(0.6, l.alpha);
      ctx.lineWidth = 4;
      ctx.strokeStyle = "#000";
      ctx.strokeText(text, lx, l.sy);
      ctx.fillStyle = l.color;
      ctx.fillText(text, lx, l.sy);
    });
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------ starfield

  var stars = [];
  var skyRunning = false;

  function buildSky() {
    var w = window.innerWidth;
    var hh = window.innerHeight;
    sky.width = Math.round(w * dpr);
    sky.height = Math.round(hh * dpr);
    var count = Math.max(80, Math.min(520, Math.round((w * hh) / 4200)));
    stars = [];
    for (var s = 0; s < count; s++) {
      var r = rand01(s * 7919 + 13);
      stars.push({
        x: rand01(s * 104729 + 1) * w,
        y: rand01(s * 1299709 + 7) * hh,
        r: r < 0.9 ? 0.6 + r * 0.6 : 1.4 + r * 0.6,
        phase: rand01(s * 31337) * Math.PI * 2,
        speed: 0.4 + rand01(s * 7331) * 1.4,
        tint: r > 0.96 ? "#ff1493" : r > 0.93 ? "#00ff41" : "#f5f5f5",
      });
    }
    drawSky(0);
  }

  function drawSky(t) {
    var w = window.innerWidth;
    var hh = window.innerHeight;
    skyCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    skyCtx.clearRect(0, 0, w, hh);
    var parX = (cam.tx * 0.015) % w;
    var parY = (cam.ty * 0.015) % hh;
    for (var s = 0; s < stars.length; s++) {
      var st = stars[s];
      var a = reduceMotion.matches ? 0.5 : 0.28 + 0.32 * (1 + Math.sin(t * 0.001 * st.speed + st.phase));
      skyCtx.globalAlpha = a;
      skyCtx.fillStyle = st.tint;
      var sx = (st.x + parX + w) % w;
      var sy = (st.y + parY + hh) % hh;
      skyCtx.fillRect(sx, sy, st.r, st.r);
    }
    skyCtx.globalAlpha = 1;
  }

  function skyLoop() {
    if (skyRunning) return;
    skyRunning = true;
    var last = 0;
    function frame(t) {
      if (reduceMotion.matches || document.hidden) {
        skyRunning = false;
        drawSky(0);
        return;
      }
      if (t - last > 60) {
        last = t;
        drawSky(t);
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ sizing

  function resize() {
    var rect = stage.getBoundingClientRect();
    var first = viewW === 0;
    viewW = Math.max(1, rect.width);
    viewH = Math.max(1, rect.height);
    dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(viewW * dpr);
    canvas.height = Math.round(viewH * dpr);
    if (first && bands.code && !userMoved) fitBands();
    requestRender();
  }

  // ------------------------------------------------------------------ hit testing + tooltip

  function hitTest(sx, sy) {
    var wx = (sx - cam.tx) / cam.k;
    var wy = (sy - cam.ty) / cam.k;
    var best = -1;
    var bestD = Infinity;
    var zoomR = Math.max(0.35, Math.min(2.2, cam.k));
    for (var i = 0; i < N; i++) {
      if (!visible[i]) continue;
      var dx = x[i] - wx;
      var dy = y[i] - wy;
      var d2 = dx * dx + dy * dy;
      var sr = Math.max(1.6, radius[i] * zoomR * 0.8) * (radius[i] * zoomR * 0.8 >= 7 ? 1.4 : 1);
      var thr = Math.max(sr, 7) / cam.k;
      if (d2 <= thr * thr && d2 < bestD) {
        bestD = d2;
        best = i;
      }
    }
    return best;
  }

  function showTooltip(i, sx, sy) {
    if (i < 0) {
      tooltip.hidden = true;
      return;
    }
    var n = nodes[i];
    tooltip.textContent = "";
    tooltip.appendChild(h("div", { className: "tid", text: n.id }));
    tooltip.appendChild(h("div", { className: "tmeta", text: n.kind + " · " + n.layer + " · " + deg[i] + " edges" }));
    if (n.label) tooltip.appendChild(h("div", { className: "tlabel", text: n.label }));
    if (n.value !== undefined) tooltip.appendChild(h("div", { className: "tvalue", text: preview(n.value, 120) }));
    if (staleSet.has(n.id)) tooltip.appendChild(h("div", { className: "tstale", text: "● STALE — locked dependencies moved" }));
    if (state.impact && state.impactMap) {
      var item = state.impactMap.get(n.id);
      if (item) tooltip.appendChild(h("div", { className: "tmeta", text: CLASS_LABEL[item.class] + " · " + item.reason }));
    }
    tooltip.hidden = false;
    var tw = tooltip.offsetWidth;
    var th = tooltip.offsetHeight;
    var left = sx + 16;
    var top = sy + 16;
    if (left + tw > viewW - 8) left = sx - tw - 16;
    if (top + th > viewH - 8) top = sy - th - 16;
    tooltip.style.left = Math.max(8, left) + "px";
    tooltip.style.top = Math.max(8, top) + "px";
  }

  // ------------------------------------------------------------------ pointer input

  var pointers = new Map();
  var drag = null;
  var pinch = null;

  function localPoint(ev) {
    var rect = canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  canvas.addEventListener("pointerdown", function (ev) {
    canvas.setPointerCapture(ev.pointerId);
    var p = localPoint(ev);
    pointers.set(ev.pointerId, p);
    if (pointers.size === 1) {
      drag = { x: p.x, y: p.y, tx: cam.tx, ty: cam.ty, moved: false };
    } else if (pointers.size === 2) {
      var pts = Array.from(pointers.values());
      pinch = { d: dist(pts[0], pts[1]), k: cam.k };
      drag = null;
    }
  });

  function dist(a, b) {
    return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)) || 1;
  }

  canvas.addEventListener("pointermove", function (ev) {
    var p = localPoint(ev);
    if (pointers.has(ev.pointerId)) pointers.set(ev.pointerId, p);
    if (pinch && pointers.size === 2) {
      var pts = Array.from(pointers.values());
      var mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      var target = pinch.k * (dist(pts[0], pts[1]) / pinch.d);
      zoomAt(target / cam.k, mid.x, mid.y);
      return;
    }
    if (drag) {
      var dx = p.x - drag.x;
      var dy = p.y - drag.y;
      if (!drag.moved && dx * dx + dy * dy > 16) {
        drag.moved = true;
        canvas.classList.add("dragging");
        tooltip.hidden = true;
      }
      if (drag.moved) {
        cam.tx = drag.tx + dx;
        cam.ty = drag.ty + dy;
        userMoved = true;
        requestRender();
      }
      return;
    }
    var hit = hitTest(p.x, p.y);
    if (hit !== state.hovered) {
      state.hovered = hit;
      canvas.classList.toggle("pointing", hit >= 0);
      requestRender();
    }
    showTooltip(hit, p.x, p.y);
  });

  function endPointer(ev) {
    var p = localPoint(ev);
    var wasClick = drag && !drag.moved && pointers.size === 1;
    pointers.delete(ev.pointerId);
    if (pointers.size < 2) pinch = null;
    canvas.classList.remove("dragging");
    if (wasClick && ev.type === "pointerup") {
      var hit = hitTest(p.x, p.y);
      if (hit >= 0) select(hit, { center: false });
      else clearSelection();
    }
    drag = null;
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", function () {
    if (drag) return;
    state.hovered = -1;
    tooltip.hidden = true;
    requestRender();
  });
  canvas.addEventListener("dblclick", function (ev) {
    var p = localPoint(ev);
    var hit = hitTest(p.x, p.y);
    if (hit >= 0) centerOn(hit);
    else zoomAt(1.6, p.x, p.y);
  });
  canvas.addEventListener(
    "wheel",
    function (ev) {
      ev.preventDefault();
      var p = localPoint(ev);
      var delta = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaY;
      zoomAt(Math.exp(-delta * (ev.ctrlKey ? 0.01 : 0.0015)), p.x, p.y);
    },
    { passive: false },
  );

  // ------------------------------------------------------------------ selection + impact

  function select(i, opts) {
    var o = opts || {};
    if (i < 0 || i >= N) return;
    reveal(i);
    if (!o.fromHistory && state.selected >= 0 && state.selected !== i) {
      state.history.push(state.selected);
      if (state.history.length > 50) state.history.shift();
    }
    state.selected = i;
    var id = nodes[i].id;
    try {
      history.replaceState(null, "", "#" + encodeURIComponent(id));
    } catch (err) {
      // file:// pages in some browsers refuse replaceState; the hash is a convenience only
    }
    if (state.impact) runImpact();
    renderPanel();
    if (o.center !== false || !isOnScreen(i)) centerOn(i);
    requestRender();
    var msg = "Selected " + nodes[i].kind + " " + id;
    if (state.impact && state.impactResult) msg += ". " + state.impactResult.items.length + " impacted.";
    announce(msg);
  }

  function clearSelection() {
    state.selected = -1;
    state.impactResult = null;
    state.impactMap = null;
    state.impactHops = [];
    state.history = [];
    panel.hidden = true;
    try {
      history.replaceState(null, "", location.pathname + location.search);
    } catch (err) {
      // see select()
    }
    requestRender();
    resize();
  }

  function runImpact() {
    if (state.selected < 0) return;
    var seed = nodes[state.selected].id;
    var result = Impact.computeImpact(impactIndex, [seed], CFG, { now: Date.now() });
    var map = new Map();
    var hops = [];
    var seen = new Set();
    var revealBudget = 300;
    result.items.forEach(function (item) {
      map.set(item.id, item);
      var color = CLASS_COLOR[item.class];
      item.path.forEach(function (hop) {
        var key = hop.from + "\u0000" + hop.to;
        if (seen.has(key)) return;
        seen.add(key);
        var a = byId.get(hop.from);
        var b = byId.get(hop.to);
        if (a === undefined || b === undefined) return;
        hops.push({ a: a, b: b, color: color });
      });
    });
    // Show the stars an impact path runs through, within reason.
    hops.forEach(function (hop) {
      [hop.a, hop.b].forEach(function (i) {
        if (baseVisible(i) || revealBudget <= 0) return;
        revealBudget--;
        reveal(i);
      });
    });
    state.impactResult = result;
    state.impactMap = map;
    state.impactHops = hops;
  }

  function setImpact(on) {
    state.impact = on;
    $("toggle-impact").setAttribute("aria-pressed", on ? "true" : "false");
    if (on && state.selected >= 0) runImpact();
    if (!on) {
      state.impactResult = null;
      state.impactMap = null;
      state.impactHops = [];
    }
    if (state.selected >= 0) renderPanel();
    setStatus(on && state.selected < 0 ? "IMPACT MODE — SELECT A STAR" : "");
    requestRender();
    announce(on ? "Impact mode on" : "Impact mode off");
  }

  // ------------------------------------------------------------------ panel

  function dotFor(id) {
    var i = byId.get(id);
    var layer = i === undefined ? "code" : nodes[i].layer;
    return h("span", { className: "dot", bg: LAYER_COLOR[layer], "aria-hidden": "true" });
  }

  function nodeLink(id, extra) {
    var known = byId.has(id);
    return h(
      "button",
      {
        type: "button",
        className: "link",
        "data-id": id,
        disabled: !known,
        "aria-label": "Select " + id,
        onclick: function () {
          if (known) select(byId.get(id));
        },
      },
      [dotFor(id), h("span", { text: id })].concat(extra || []),
    );
  }

  function pretty(value) {
    if (typeof value === "string") return value;
    return JSON.stringify(value, null, 2);
  }

  function renderPanel() {
    var i = state.selected;
    if (i < 0) {
      panel.hidden = true;
      return;
    }
    var n = nodes[i];
    var wasHidden = panel.hidden;
    panel.hidden = false;
    panelBack.hidden = state.history.length === 0;
    panelBody.textContent = "";
    var badges = h("div", null, [h("span", { className: "kind-badge " + n.layer, text: n.kind })]);
    if (staleSet.has(n.id)) badges.appendChild(h("span", { className: "kind-badge stale", text: "stale" }));
    panelBody.appendChild(badges);
    panelBody.appendChild(h("h2", { className: "node-id", text: n.id }));
    if (n.label) panelBody.appendChild(h("p", { className: "node-label", text: n.label }));

    if (state.impact && state.impactResult) renderImpact(state.impactResult);

    if (n.value !== undefined) {
      panelBody.appendChild(h("h3", { text: "VALUE" }));
      panelBody.appendChild(h("pre", { className: "value", text: pretty(n.value) }));
    }
    if (Object.prototype.hasOwnProperty.call(lockFacts, n.id)) {
      var locked = lockFacts[n.id];
      if (JSON.stringify(locked) !== JSON.stringify(n.value)) {
        panelBody.appendChild(h("h3", { text: "LOCKED VALUE (WHAT THE WORLD WAS SYNCED TO)" }));
        panelBody.appendChild(h("pre", { className: "value previous", text: pretty(locked) }));
      }
    }

    var fields = [];
    var scalar = ["authority", "status", "validThrough", "hash"];
    scalar.forEach(function (f) {
      if (n[f] !== undefined) fields.push([f, String(n[f])]);
    });
    if (n.types && n.types.length) fields.push(["types", n.types.join(", ")]);
    if (n.owners && n.owners.length) fields.push(["owners", n.owners.join(", ")]);
    if (n.tags && n.tags.length) fields.push(["tags", n.tags.join(", ")]);
    if (n.location) fields.push(["location", n.location.file + (n.location.line ? ":" + n.location.line : "")]);
    fields.push(["degree", String(deg[i])]);
    panelBody.appendChild(h("h3", { text: "FIELDS" }));
    var dl = h("dl", { className: "fields" });
    fields.forEach(function (f) {
      dl.appendChild(h("dt", { text: f[0] }));
      dl.appendChild(h("dd", { text: f[1] }));
    });
    panelBody.appendChild(dl);

    [
      ["BINDING", n.binding],
      ["SOURCE", n.source],
      ["META", n.meta],
    ].forEach(function (pair) {
      if (pair[1] === undefined) return;
      panelBody.appendChild(h("h3", { text: pair[0] }));
      panelBody.appendChild(h("pre", { className: "value", text: pretty(pair[1]) }));
    });

    renderEdgeGroups("OUTGOING", impactIndex.out.get(n.id) || [], "to");
    renderEdgeGroups("INCOMING", impactIndex.inc.get(n.id) || [], "from");

    if (wasHidden) resize();
  }

  function renderEdgeGroups(title, list, end) {
    panelBody.appendChild(h("h3", { text: title + " · " + fmt(list.length) }));
    if (!list.length) {
      panelBody.appendChild(h("p", { className: "empty-note", text: "None." }));
      return;
    }
    var groups = {};
    list.forEach(function (e) {
      (groups[e.type] = groups[e.type] || []).push(e);
    });
    Object.keys(groups)
      .sort()
      .forEach(function (type) {
        var items = groups[type];
        var box = h("div", { className: "edge-group" }, [
          h("h4", null, [
            h("span", { className: "swatch", bg: CAT_COLOR[edgeCategory(type)], "aria-hidden": "true" }),
            h("span", { text: type }),
            h("span", { className: "count", text: String(items.length) }),
          ]),
        ]);
        var ul = h("ul", { className: "links" });
        items.slice(0, MAX_LINKS).forEach(function (e) {
          var extra = e.confidence !== undefined && e.confidence < 1 ? [h("span", { className: "conf", text: Math.round(e.confidence * 100) + "%" })] : [];
          ul.appendChild(h("li", null, [nodeLink(e[end], extra)]));
        });
        box.appendChild(ul);
        if (items.length > MAX_LINKS) box.appendChild(h("p", { className: "empty-note", text: "+" + fmt(items.length - MAX_LINKS) + " more" }));
        panelBody.appendChild(box);
      });
  }

  function renderImpact(result) {
    var items = result.items;
    panelBody.appendChild(h("h3", { text: "IMPACT · " + fmt(items.length) + " DOWNSTREAM" }));
    if (!items.length) {
      panelBody.appendChild(h("p", { className: "empty-note", text: "Nothing downstream. Changing this star touches nothing else in the chart." }));
      return;
    }
    var byClass = {};
    items.forEach(function (it) {
      (byClass[it.class] = byClass[it.class] || []).push(it);
    });
    var summary = h("div", { className: "impact-summary" });
    CLASS_ORDER.forEach(function (cls) {
      if (!byClass[cls]) return;
      summary.appendChild(h("span", { className: "cls-chip", bg: CLASS_COLOR[cls], text: CLASS_LABEL[cls] + " " + byClass[cls].length }));
    });
    panelBody.appendChild(summary);
    CLASS_ORDER.forEach(function (cls) {
      var list = byClass[cls];
      if (!list) return;
      var group = h("section", { className: "impact-group", "aria-label": CLASS_LABEL[cls] }, [
        h("h4", { text: CLASS_LABEL[cls] + " · " + list.length }),
      ]);
      group.firstChild.style.color = CLASS_COLOR[cls];
      var strong = list.filter(function (it) {
        return it.confidence >= LOW_CONFIDENCE;
      });
      var weak = list.filter(function (it) {
        return it.confidence < LOW_CONFIDENCE;
      });
      strong.forEach(function (it) {
        group.appendChild(impactItem(it));
      });
      if (weak.length) {
        var det = h("details", { className: "low" }, [h("summary", { text: weak.length + " low-confidence" })]);
        weak.forEach(function (it) {
          det.appendChild(impactItem(it));
        });
        group.appendChild(det);
      }
      panelBody.appendChild(group);
    });
  }

  function impactItem(it) {
    return h("div", { className: "impact-item", borderColor: CLASS_COLOR[it.class] }, [
      nodeLink(it.id, [h("span", { className: "conf", text: Math.round(it.confidence * 100) + "%" })]),
      h("p", { className: "reason", text: it.reason }),
      h("p", { className: "why", text: "why: " + Impact.explainPath(it.path) }),
    ]);
  }

  // ------------------------------------------------------------------ search

  var results = [];
  var activeResult = -1;

  function score(q, n) {
    var id = n.id.toLowerCase();
    var label = (n.label || "").toLowerCase();
    var at = id.indexOf(q);
    if (at !== -1) return 1000 - at * 2 - id.length * 0.1 + (at === 0 || id.charAt(at - 1).match(/[:/.]/) ? 60 : 0);
    var la = label.indexOf(q);
    if (la !== -1) return 900 - la * 2 - label.length * 0.1 + (label === q ? 100 : 0);
    // subsequence: every query char in order, rewarding tight runs
    var hay = id + " " + label;
    var pos = -1;
    var gaps = 0;
    for (var c = 0; c < q.length; c++) {
      var nxt = hay.indexOf(q.charAt(c), pos + 1);
      if (nxt === -1) return -1;
      if (pos !== -1) gaps += nxt - pos - 1;
      pos = nxt;
    }
    return 500 - gaps * 3 - hay.length * 0.05;
  }

  function runSearch() {
    var q = searchInput.value.trim().toLowerCase();
    results = [];
    if (q) {
      var scored = [];
      for (var i = 0; i < N; i++) {
        var s = score(q, nodes[i]);
        if (s > 0) scored.push({ i: i, s: s });
      }
      scored.sort(function (a, b) {
        return b.s - a.s;
      });
      results = scored.slice(0, 10).map(function (r) {
        return r.i;
      });
    }
    activeResult = results.length ? 0 : -1;
    renderResults(q);
  }

  function renderResults(q) {
    resultsEl.textContent = "";
    if (!q) {
      resultsEl.hidden = true;
      searchInput.setAttribute("aria-expanded", "false");
      searchInput.removeAttribute("aria-activedescendant");
      return;
    }
    if (!results.length) {
      resultsEl.appendChild(h("li", { className: "empty", role: "option", "aria-disabled": "true", text: "No stars match “" + q + "”" }));
    }
    results.forEach(function (i, k) {
      var n = nodes[i];
      var li = h(
        "li",
        { id: "sr-" + k, role: "option", "aria-selected": k === activeResult ? "true" : "false" },
        [
          h("span", { className: "dot", bg: LAYER_COLOR[n.layer], "aria-hidden": "true" }),
          h("span", { className: "rid", text: n.label ? n.label + " — " + n.id : n.id }),
          h("span", { className: "rkind", text: n.kind }),
        ],
      );
      li.addEventListener("mousedown", function (ev) {
        ev.preventDefault();
      });
      li.addEventListener("click", function () {
        chooseResult(k);
      });
      resultsEl.appendChild(li);
    });
    resultsEl.hidden = false;
    searchInput.setAttribute("aria-expanded", "true");
    if (activeResult >= 0) searchInput.setAttribute("aria-activedescendant", "sr-" + activeResult);
    else searchInput.removeAttribute("aria-activedescendant");
  }

  function chooseResult(k) {
    var i = results[k];
    if (i === undefined) return;
    closeResults();
    select(i);
    canvas.focus({ preventScroll: true });
  }

  function closeResults() {
    resultsEl.hidden = true;
    searchInput.setAttribute("aria-expanded", "false");
    searchInput.removeAttribute("aria-activedescendant");
  }

  searchInput.addEventListener("input", runSearch);
  searchInput.addEventListener("keydown", function (ev) {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
      if (!results.length) return;
      ev.preventDefault();
      activeResult = (activeResult + (ev.key === "ArrowDown" ? 1 : -1) + results.length) % results.length;
      renderResults(searchInput.value.trim().toLowerCase());
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      if (results.length) chooseResult(activeResult >= 0 ? activeResult : 0);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      if (!resultsEl.hidden) closeResults();
      else searchInput.blur();
    }
  });
  searchInput.addEventListener("blur", function () {
    window.setTimeout(closeResults, 120);
  });
  searchInput.addEventListener("focus", function () {
    if (searchInput.value.trim()) runSearch();
  });

  // ------------------------------------------------------------------ toolbar + legend

  function syncChips() {
    Array.prototype.forEach.call(document.querySelectorAll(".chip[data-layer]"), function (b) {
      b.setAttribute("aria-pressed", state.layers[b.getAttribute("data-layer")] ? "true" : "false");
    });
  }

  Array.prototype.forEach.call(document.querySelectorAll(".chip[data-layer]"), function (b) {
    b.addEventListener("click", function () {
      var layer = b.getAttribute("data-layer");
      state.layers[layer] = !state.layers[layer];
      syncChips();
      computeVisibility();
      if (state.selected >= 0 && !visible[state.selected]) clearSelection();
      requestRender();
      announce(BAND_LABEL[layer] + (state.layers[layer] ? " shown" : " hidden"));
    });
  });

  $("toggle-code").addEventListener("click", function () {
    state.showAllCode = !state.showAllCode;
    this.setAttribute("aria-pressed", state.showAllCode ? "true" : "false");
    runLayout(true);
    announce(state.showAllCode ? "Showing all code nodes" : "Showing surface code nodes");
  });
  $("toggle-impact").addEventListener("click", function () {
    setImpact(!state.impact);
  });
  $("zoom-in").addEventListener("click", function () {
    zoomAt(1.35, viewW / 2, viewH / 2);
  });
  $("zoom-out").addEventListener("click", function () {
    zoomAt(1 / 1.35, viewW / 2, viewH / 2);
  });
  $("zoom-fit").addEventListener("click", function () {
    fit(true);
  });
  $("panel-close").addEventListener("click", function () {
    clearSelection();
    canvas.focus({ preventScroll: true });
  });
  panelBack.addEventListener("click", function () {
    var prev = state.history.pop();
    if (prev !== undefined) select(prev, { fromHistory: true });
  });

  function setupLegendToggle() {
    var btn = $("legend-toggle");
    var list = $("legend");
    var apply = function (open) {
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      list.hidden = !open;
    };
    apply(window.innerWidth >= 1200 && window.innerHeight >= 760);
    btn.addEventListener("click", function () {
      apply(btn.getAttribute("aria-expanded") !== "true");
    });
  }

  function buildLegend() {
    setupLegendToggle();
    var ul = $("legend");
    var cats = ["bridge", "world", "fact", "code"];
    Object.keys(edgeTypeCount)
      .sort(function (a, b) {
        return cats.indexOf(edgeCategory(a)) - cats.indexOf(edgeCategory(b)) || a.localeCompare(b);
      })
      .forEach(function (type) {
        var btn = h(
          "button",
          {
            type: "button",
            "aria-pressed": "true",
            "aria-label": "Toggle " + type + " edges (" + edgeTypeCount[type] + ")",
            onclick: function () {
              state.hiddenTypes[type] = !state.hiddenTypes[type];
              btn.setAttribute("aria-pressed", state.hiddenTypes[type] ? "false" : "true");
              requestRender();
            },
          },
          [
            h("span", { className: "swatch", bg: CAT_COLOR[edgeCategory(type)], "aria-hidden": "true" }),
            h("span", { text: type }),
            h("span", { className: "count", text: fmt(edgeTypeCount[type]) }),
          ],
        );
        ul.appendChild(h("li", null, [btn]));
      });
    if (!ul.firstChild) ul.appendChild(h("li", { className: "empty-note", text: "No edges yet." }));
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  // ------------------------------------------------------------------ keyboard

  function orderedVisible() {
    var list = [];
    for (var i = 0; i < N; i++) if (visible[i]) list.push(i);
    list.sort(function (a, b) {
      var la = BAND_ORDER.indexOf(nodes[a].layer);
      var lb = BAND_ORDER.indexOf(nodes[b].layer);
      return la - lb || x[a] - x[b];
    });
    return list;
  }

  function stepSelection(dir) {
    var list = orderedVisible();
    if (!list.length) return;
    var at = list.indexOf(state.selected);
    var next = at === -1 ? (dir > 0 ? 0 : list.length - 1) : (at + dir + list.length) % list.length;
    select(list[next]);
  }

  document.addEventListener("keydown", function (ev) {
    var target = ev.target;
    var typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
    if (typing || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    var key = ev.key;
    if (key === "/") {
      ev.preventDefault();
      searchInput.focus();
      searchInput.select();
    } else if (key === "Escape") {
      if (state.selected >= 0) clearSelection();
      else if (state.impact) setImpact(false);
    } else if (key === "i" || key === "I") {
      setImpact(!state.impact);
    } else if (key === "f" || key === "F") {
      fit(true);
    } else if (key === "+" || key === "=") {
      zoomAt(1.25, viewW / 2, viewH / 2);
    } else if (key === "-" || key === "_") {
      zoomAt(0.8, viewW / 2, viewH / 2);
    } else if (key === "n" || key === "N") {
      stepSelection(1);
    } else if (key === "p" || key === "P") {
      stepSelection(-1);
    } else if (target === canvas && key.indexOf("Arrow") === 0) {
      ev.preventDefault();
      var d = 60;
      if (key === "ArrowLeft") cam.tx += d;
      if (key === "ArrowRight") cam.tx -= d;
      if (key === "ArrowUp") cam.ty += d;
      if (key === "ArrowDown") cam.ty -= d;
      userMoved = true;
      requestRender();
    } else if (target === canvas && key === "Enter" && state.selected >= 0) {
      var first = panelBody.querySelector("button");
      if (first) first.focus();
    }
  });

  // ------------------------------------------------------------------ hash + live reload

  function selectFromHash() {
    var raw = location.hash.slice(1);
    if (!raw) return;
    var id;
    try {
      id = decodeURIComponent(raw);
    } catch (err) {
      id = raw;
    }
    var i = byId.get(id);
    if (i !== undefined && i !== state.selected) select(i);
  }
  window.addEventListener("hashchange", selectFromHash);

  var SESSION_KEY = "starchart:view:" + DATA.name;

  function saveSession() {
    try {
      sessionStorage.setItem(
        SESSION_KEY,
        JSON.stringify({
          cam: cam,
          layers: state.layers,
          showAllCode: state.showAllCode,
          impact: state.impact,
          hiddenTypes: state.hiddenTypes,
        }),
      );
    } catch (err) {
      // storage may be disabled; live reload then simply starts fresh
    }
  }

  function restoreSession() {
    var raw = null;
    try {
      raw = sessionStorage.getItem(SESSION_KEY);
      sessionStorage.removeItem(SESSION_KEY);
    } catch (err) {
      return false;
    }
    if (!raw) return false;
    var s;
    try {
      s = JSON.parse(raw);
    } catch (err) {
      return false;
    }
    if (s.layers) state.layers = { world: s.layers.world !== false, fact: s.layers.fact !== false, code: s.layers.code !== false };
    state.showAllCode = !!s.showAllCode;
    state.hiddenTypes = s.hiddenTypes || {};
    $("toggle-code").setAttribute("aria-pressed", state.showAllCode ? "true" : "false");
    syncChips();
    if (s.impact) {
      state.impact = true;
      $("toggle-impact").setAttribute("aria-pressed", "true");
    }
    if (s.cam && typeof s.cam.k === "number") {
      cam.k = s.cam.k;
      cam.tx = s.cam.tx;
      cam.ty = s.cam.ty;
      userMoved = true;
    }
    return true;
  }

  function listenLive() {
    if (!DATA.live || typeof EventSource === "undefined") return;
    var es = new EventSource("/events");
    es.addEventListener("change", function () {
      saveSession();
      document.body.appendChild(h("div", { className: "toast", role: "status", text: "CHART UPDATED — RELOADING" }));
      window.setTimeout(function () {
        location.reload();
      }, 250);
    });
  }

  // ------------------------------------------------------------------ boot

  function boot() {
    buildLegend();
    var restored = restoreSession();
    for (var i = 0; i < N; i++) inLayout[i] = baseVisible(i) ? 1 : 0;
    computeBands();
    resize();
    if (!restored) fitBands();
    buildSky();
    if (!reduceMotion.matches) skyLoop();
    if (N === 0) {
      setStatus("EMPTY CHART — ADD ENTITIES OR ARTIFACTS UNDER .starchart/");
      requestRender();
    } else {
      // band-only framing is a placeholder; frame the settled stars unless the user took the wheel
      layoutDoneCallbacks.push(function () {
        if (!restored && !userMoved) fit(false);
      });
      layoutDoneCallbacks.push(selectFromHash);
      runLayout(false);
    }
    listenLive();
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(resize).observe(stage);
    else window.addEventListener("resize", resize);
    window.addEventListener("resize", buildSky);
    var onMotionChange = function () {
      if (reduceMotion.matches) drawSky(0);
      else skyLoop();
      requestRender();
    };
    if (reduceMotion.addEventListener) reduceMotion.addEventListener("change", onMotionChange);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden && !reduceMotion.matches) skyLoop();
    });
  }

  boot();
})();
