/*
 * STARCHART X-Ray matcher. Pure functions, no DOM.
 *
 * Loaded three ways, so it is written as a classic script that publishes
 * `globalThis.StarchartMatch`:
 *   - injected into pages before xray.js (chrome.scripting.executeScript files),
 *   - importScripts()'d / listed by the background worker,
 *   - side-effect imported by the vitest suite.
 */
(function (root) {
  "use strict";

  var NUMERIC = /^[+-]?\d[\d,]*(?:\.\d+)?$/;
  var MIN_LENGTH = 2;
  var CURRENCY = /[$€£¥₹]/;
  var cache = new WeakMap();

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Regex source for one displayed value, with token boundaries:
   * - numbers must not sit inside a longer number ("4.99" never matches in "14.99" or "4.995"),
   *   but a trailing sentence period is fine ("costs 4.99.");
   * - words must not sit inside a longer word ("Pro" never matches in "Protect").
   * Whitespace inside a value matches any run of whitespace, including no-break spaces.
   */
  function valuePattern(value) {
    var body = escapeRegExp(value).replace(/\s+/g, "[\\s\\u00a0]+");
    var first = value.charAt(0);
    var last = value.charAt(value.length - 1);
    var before = "";
    var after = "";
    if (NUMERIC.test(value)) {
      before = "(?<![\\p{N}.,])";
      after = "(?![\\p{N}]|[.,][\\p{N}])";
    } else {
      if (/[\p{L}\p{N}]/u.test(first)) before = "(?<![\\p{L}\\p{N}_])";
      if (/[\p{L}\p{N}]/u.test(last)) after = "(?![\\p{L}\\p{N}_])";
    }
    return before + body + after;
  }

  /** Stringifies a fact value the way a page displays it, or returns null when unusable. */
  function displayValue(value) {
    if (typeof value === "number" && isFinite(value)) return String(value);
    if (typeof value === "string") {
      var trimmed = value.trim();
      return trimmed.length >= MIN_LENGTH ? trimmed : null;
    }
    return null;
  }

  /**
   * Compiles facts ([{ id, value, previous? }]) into a reusable matcher.
   * Each distinct needle string gets one entry; current values win over stale ones.
   */
  function createMatcher(facts) {
    var byNeedle = new Map();
    for (var i = 0; i < facts.length; i++) {
      var f = facts[i];
      var current = displayValue(f.value);
      if (current !== null && current.length >= MIN_LENGTH) addNeedle(byNeedle, current, f.id, "sync");
      var previous = f.previous === undefined || f.previous === null ? null : displayValue(f.previous);
      if (previous !== null && previous.length >= MIN_LENGTH && previous !== current) {
        addNeedle(byNeedle, previous, f.id, "stale");
      }
    }
    var needles = [];
    byNeedle.forEach(function (entry, text) {
      needles.push({
        text: text,
        factId: entry.factId,
        status: entry.status,
        numeric: NUMERIC.test(text),
        re: new RegExp(valuePattern(text), "gu"),
      });
    });
    // Longest first, so "Pro+" claims its span before "Pro" can.
    needles.sort(function (a, b) {
      return b.text.length - a.text.length || (a.status === "sync" ? -1 : 1) - (b.status === "sync" ? -1 : 1);
    });
    return function match(text, options) {
      return runMatcher(needles, text, options || {});
    };
  }

  function addNeedle(map, text, factId, status) {
    var existing = map.get(text);
    // A value that is current for any fact is in sync, even if it is another fact's old value.
    if (!existing || (existing.status === "stale" && status === "sync")) map.set(text, { factId: factId, status: status });
  }

  var PRICE = new RegExp(
    "(?<![\\p{L}\\p{N}.,])(?:" +
      "[$€£¥₹]\\s?\\d{1,3}(?:[,.\\u00a0 ]\\d{3})*(?:[.,]\\d{1,2})?" +
      "|\\d{1,3}(?:[,.\\u00a0 ]\\d{3})*(?:[.,]\\d{1,2})?\\s?(?:[€£¥₹]|USD|EUR|GBP|CAD|AUD|JPY)" +
      ")(?![\\p{L}\\p{N}]|[.,]\\p{N})",
    "gu",
  );

  function overlaps(taken, start, end) {
    for (var i = 0; i < taken.length; i++) if (start < taken[i].end && end > taken[i].start) return true;
    return false;
  }

  function runMatcher(needles, text, options) {
    var found = [];
    if (!text) return found;
    for (var i = 0; i < needles.length; i++) {
      var n = needles[i];
      if (text.indexOf(n.text.split(/\s/)[0]) === -1) continue;
      n.re.lastIndex = 0;
      var m;
      while ((m = n.re.exec(text)) !== null) {
        var start = m.index;
        var end = start + m[0].length;
        // "$5.99": the mark covers the currency symbol the page prints in front of the amount.
        if (n.numeric && start > 0 && CURRENCY.test(text.charAt(start - 1))) start--;
        if (!overlaps(found, start, end)) found.push({ start: start, end: end, factId: n.factId, status: n.status });
        if (m[0].length === 0) n.re.lastIndex++;
      }
    }
    if (options.unbound) {
      PRICE.lastIndex = 0;
      var p;
      while ((p = PRICE.exec(text)) !== null) {
        var s = p.index;
        var e = s + p[0].length;
        if (!overlaps(found, s, e)) found.push({ start: s, end: e, factId: null, status: "unbound" });
      }
    }
    found.sort(function (a, b) {
      return a.start - b.start;
    });
    return found;
  }

  /**
   * Finds fact values in `text`: [{ start, end, factId, status }] sorted by start, non-overlapping.
   * status: "sync" (current value), "stale" (a previous value the page still shows) or,
   * with options.unbound, "unbound" (a currency amount no fact accounts for; factId null).
   */
  function findMatches(text, facts, options) {
    var matcher = cache.get(facts);
    if (!matcher) {
      matcher = createMatcher(facts);
      cache.set(facts, matcher);
    }
    return matcher(text, options);
  }

  /**
   * Whether `url` is covered by an artifact URL `pattern`. Patterns may use "*" wildcards;
   * a plain URL covers itself and anything below it, ignoring query, hash and trailing slash.
   */
  function urlMatches(pattern, url) {
    if (!pattern || !url) return false;
    if (pattern.indexOf("*") !== -1) {
      var re = new RegExp("^" + pattern.split("*").map(escapeRegExp).join(".*") + "$");
      return re.test(url);
    }
    var a = stripUrl(pattern);
    var b = stripUrl(url);
    return b === a || b.indexOf(a + "/") === 0;
  }

  function stripUrl(u) {
    return u.replace(/[?#].*$/, "").replace(/\/+$/, "");
  }

  /** Host-permission match pattern for an artifact URL pattern, e.g. "https://example.com/*". */
  function originPattern(pattern) {
    var m = /^(https?):\/\/([^/?#]+)/.exec(pattern || "");
    if (!m) return null;
    var host = m[2].replace(/:\d+$/, "");
    if (host.indexOf("*") !== -1 && !/^\*\.[^*]+$/.test(host)) return null;
    return m[1] + "://" + host + "/*";
  }

  root.StarchartMatch = {
    findMatches: findMatches,
    createMatcher: createMatcher,
    displayValue: displayValue,
    urlMatches: urlMatches,
    originPattern: originPattern,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
