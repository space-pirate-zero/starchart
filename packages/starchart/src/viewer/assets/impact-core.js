/*
 * STARCHART impact traversal — browser port of src/core/impact.ts.
 *
 * Classic script (no import/export) so it can be inlined into the viewer page, and
 * side-effect imported from tests. It publishes `globalThis.StarchartImpact`.
 *
 * Every table it needs (edge propagation, per-edge confidence decay, media types,
 * writable adapters) is injected by the server from the core at render time, so the
 * rules never diverge from `computeImpact`. The traversal order mirrors the core
 * Graph's insertion-ordered edge indexes, so shortest "why" paths match as well.
 */
(function (root) {
  "use strict";

  /**
   * Indexes a serialized graph ({ nodes, edges }) the same way core's Graph does:
   * edges keyed by from/type/to, outgoing and incoming lists in insertion order.
   */
  function createIndex(graph) {
    var nodes = new Map();
    var out = new Map();
    var inc = new Map();
    var seen = new Set();
    var i;
    for (i = 0; i < graph.nodes.length; i++) nodes.set(graph.nodes[i].id, graph.nodes[i]);
    for (i = 0; i < graph.edges.length; i++) {
      var e = graph.edges[i];
      var key = e.from + "\u0000" + e.type + "\u0000" + e.to;
      if (seen.has(key)) continue;
      seen.add(key);
      push(out, e.from, e);
      push(inc, e.to, e);
    }
    return { nodes: nodes, out: out, inc: inc };
  }

  function push(map, key, value) {
    var list = map.get(key);
    if (!list) {
      list = [];
      map.set(key, list);
    }
    list.push(value);
  }

  /** Nodes impacted when `id` changes, honouring each edge type's propagation direction. */
  function neighbors(index, id, cfg) {
    var result = [];
    var incoming = index.inc.get(id) || [];
    var outgoing = index.out.get(id) || [];
    var i, e, p;
    for (i = 0; i < incoming.length; i++) {
      e = incoming[i];
      p = cfg.propagation[e.type];
      if (p === "reverse" || p === "both") result.push({ edge: e, target: e.from });
    }
    for (i = 0; i < outgoing.length; i++) {
      e = outgoing[i];
      p = cfg.propagation[e.type];
      if (p === "forward" || p === "both") result.push({ edge: e, target: e.to });
    }
    // A changed symbol means its file changed, for the coarse file-level `imports` graph.
    for (i = 0; i < incoming.length; i++) {
      e = incoming[i];
      if (e.type === "contains") result.push({ edge: e, target: e.from, contains: true });
    }
    return result;
  }

  function reportCode(node, via, mode) {
    if (mode === "all") return true;
    if (mode === "none") return false;
    return node.kind === "screen" || node.kind === "route" || node.kind === "test" || via === "anchors";
  }

  function classify(index, node, via, path, cfg, nowMs) {
    if (node.layer === "code") {
      if (node.kind === "test") return { cls: "test", reason: "run these tests" };
      if (via === "anchors") {
        if (node.meta && node.meta.generated) return { cls: "auto", reason: "regenerate fact constants (codegen)" };
        var fromNode = index.nodes.get(path[path.length - 1].from);
        if (fromNode && fromNode.kind === "artifact") return { cls: "code", reason: "holds this artifact's external id; update it if the id changes" };
        return { cls: "code", reason: "hardcoded value anchors this fact; update or switch to codegen" };
      }
      return { cls: "info", reason: node.kind + " affected" };
    }
    if (node.layer === "fact") return { cls: "info", reason: "derived fact changes" };

    if (node.validThrough && Date.parse(node.validThrough) < nowMs) {
      return { cls: "retire", reason: "expired " + node.validThrough };
    }
    var retiredOnPath = false;
    for (var i = 0; i < path.length; i++) {
      var hopNode = index.nodes.get(path[i].from);
      if (hopNode && hopNode.status === "retired") {
        retiredOnPath = true;
        break;
      }
    }
    if (retiredOnPath && (via === "promotes" || via === "embeds" || via === "describes")) {
      return { cls: "retire", reason: "depends on a retired entity" };
    }
    var adapter = node.binding ? node.binding.adapter : undefined;
    var writable = adapter ? cfg.writable.indexOf(adapter) !== -1 && (cfg.unwritable || []).indexOf(node.id) === -1 : false;
    var isMedia = false;
    if (node.types) {
      for (var t = 0; t < node.types.length; t++) {
        if (cfg.mediaTypes.indexOf(node.types[t]) !== -1) isMedia = true;
      }
    }
    switch (via) {
      case "renders":
        return { cls: "auto", reason: "regenerate from template" };
      case "embeds":
        if (isMedia) return { cls: "manual", reason: "value is burned into media" };
        return writable
          ? { cls: "auto", reason: "replace embedded value" }
          : { cls: "manual", reason: adapter ? 'adapter "' + adapter + '" cannot write' : "no binding" };
      case "mirrors":
        return writable
          ? { cls: "auto", reason: "sync via " + adapter }
          : { cls: "manual", reason: adapter ? "update in " + adapter + " (adapter is read-only)" : "no binding" };
      case "captures":
        return { cls: "manual", reason: "screen changed; re-capture" };
      case "describes":
        return { cls: "review", reason: "describes this semantically" };
      case "promotes":
        return { cls: "review", reason: "promotes this; check it still holds" };
      case "derivedFrom":
        return { cls: "review", reason: "derived from a changed artifact" };
      case "publishes":
        return { cls: "review", reason: "published page changed" };
      case "emits":
        return { cls: "review", reason: "emitted event/ID changed" };
      default:
        return { cls: "review", reason: "impacted via " + via };
    }
  }

  function round(n) {
    return Math.round(n * 100) / 100;
  }

  /**
   * Breadth-first impact walk from `seeds`. Returns { seeds, items } where each item is
   * { id, node, depth, confidence, via, path, class, reason }, sorted like the core.
   * options: { now?: Date | number, includeCode?: "surface" | "all" | "none" }.
   */
  function computeImpact(index, seeds, cfg, options) {
    var opts = options || {};
    var maxDepth = cfg.maxDepth;
    var maxCodeDepth = cfg.maxCodeDepth;
    var minConfidence = cfg.minConfidence;
    var includeCode = opts.includeCode || "surface";
    var nowMs = opts.now === undefined ? Date.now() : typeof opts.now === "number" ? opts.now : opts.now.getTime();

    var seedList = [];
    var seedSet = new Set();
    var visited = new Map();
    var queue = [];
    for (var s = 0; s < seeds.length; s++) {
      var sid = seeds[s];
      if (!index.nodes.has(sid) || seedSet.has(sid)) continue;
      seedSet.add(sid);
      seedList.push(sid);
      var seedEntry = { id: sid, depth: 0, codeDepth: 0, confidence: 1, path: [] };
      visited.set(sid, seedEntry);
      queue.push(seedEntry);
    }

    for (var head = 0; head < queue.length; head++) {
      var current = queue[head];
      if (current.depth >= maxDepth) continue;
      var currentNode = index.nodes.get(current.id);
      var next = neighbors(index, current.id, cfg);
      for (var n = 0; n < next.length; n++) {
        var edge = next[n].edge;
        var target = next[n].target;
        if (visited.has(target)) continue;
        var targetNode = index.nodes.get(target);
        if (!targetNode) continue;
        var codeHop = !!currentNode && currentNode.layer === "code" && targetNode.layer === "code";
        var codeDepth = codeHop ? current.codeDepth + 1 : 0;
        if (codeDepth > maxCodeDepth) continue;
        var edgeConfidence = next[n].contains
          ? cfg.containsConfidence
          : (edge.confidence === undefined ? 1 : edge.confidence) * (cfg.decay[edge.type] === undefined ? 1 : cfg.decay[edge.type]);
        var confidence = current.confidence * edgeConfidence;
        if (confidence < minConfidence) continue;
        var entry = {
          id: target,
          depth: current.depth + 1,
          codeDepth: codeDepth,
          confidence: confidence,
          path: current.path.concat([{ from: current.id, to: target, type: edge.type }]),
        };
        visited.set(target, entry);
        queue.push(entry);
      }
    }

    var items = [];
    visited.forEach(function (v) {
      if (seedSet.has(v.id)) return;
      var node = index.nodes.get(v.id);
      var via = v.path[v.path.length - 1].type;
      if (node.layer === "code" && !reportCode(node, via, includeCode)) return;
      var c = classify(index, node, via, v.path, cfg, nowMs);
      items.push({
        id: v.id,
        node: node,
        depth: v.depth,
        confidence: round(v.confidence),
        via: via,
        path: v.path,
        class: c.cls,
        reason: c.reason,
      });
    });
    items.sort(function (a, b) {
      return a.depth - b.depth || a.id.localeCompare(b.id);
    });
    return { seeds: seedList, items: items };
  }

  /** Human-readable explanation, e.g. `a --references--> b --captures--> c`. */
  function explainPath(path) {
    if (!path.length) return "";
    var parts = [path[0].from];
    for (var i = 0; i < path.length; i++) parts.push("--" + path[i].type + "--> " + path[i].to);
    return parts.join(" ");
  }

  root.StarchartImpact = {
    createIndex: createIndex,
    neighbors: neighbors,
    classify: classify,
    computeImpact: computeImpact,
    explainPath: explainPath,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
