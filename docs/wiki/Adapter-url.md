The `url` adapter checks live web pages: your deployed pricing page, a landing page, anything a customer or crawler actually sees. It fetches the page, pulls out the visible text, social meta tags and JSON-LD, and checks them for stale and missing fact values. It is read-only by design. There is no `apply`, and no setting changes that. This page covers the binding, URL resolution, text extraction, audit semantics and error handling.

Source: [`adapters/url.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/adapters/url.ts).

## Binding

```yaml
- id: web:live-pricing
  binding: { adapter: url, url: /pricing }
  embeds: [addon:pro.price.usd]
  after: [web:pricing-page]
```

| Field | Required | Meaning |
|---|---|---|
| `adapter` | yes | `url` |
| `url` | yes | An absolute `http(s)://` URL, or a path relative to `site` in `.starchart/config.yaml` |

A binding without `url` throws `<id>: url binding needs a "url"`, which audit reports under errors.

## URL resolution

Absolute URLs are used as-is. Relative URLs resolve against the top-level `site` setting (the engine merges `site` into every adapter's settings):

```yaml
# .starchart/config.yaml
site: https://nebula.example.com
```

Leading slashes are stripped and `site` gets a trailing slash, so a base path is kept:

| `site` | `url` | Fetched |
|---|---|---|
| `https://nebula.example.com` | `/pricing` | `https://nebula.example.com/pricing` |
| `https://example.com/base` | `/pricing` | `https://example.com/base/pricing` |
| (unset) | `/pricing` | error: `relative url "/pricing" needs "site" in .starchart/config.yaml` |

The [Reality X-Ray](Reality-X-Ray) payload resolves relative binding URLs the same way (leading slashes stripped, the site's base path kept), so both see the same page.

## What text is checked

`extractPageText(html)` builds the text a reader or crawler sees:

| Included | Excluded |
|---|---|
| `<title>` | `<script>` (other than JSON-LD), `<style>`, `<noscript>`, `<template>`, `<svg>` |
| Visible body text, with tags stripped and block tags (`p`, `div`, `li`, `tr`, `h1`–`h6`, `section`, `article`, `header`, `footer`, `br`) turned into line breaks | HTML comments |
| `<meta>` `content` for `og:*`, `twitter:*`, `product:*` and `description` | the rest of `<head>` |
| Every `<script type="application/ld+json">` block, raw | |

Named and numeric HTML entities are decoded (`&amp;`, `&nbsp;`, `&euro;`, `&#36;`, `&#x20AC;` and friends), and whitespace runs collapse to single spaces.

So a stale price in `og:description` or in your JSON-LD `Offer` is caught even if the visible page is correct. That's often where old prices hide.

The adapter parses HTML with regular expressions, not a DOM. It sees the server-rendered HTML only. Content injected by client-side JavaScript after load is invisible to it.

## Audit

1. Collect leaf facts reached through `embeds`, `mirrors` and `renders` (containers expand to leaves). `describes` edges are semantic and never checked here.
2. `GET` the URL with `user-agent: starchart-audit` and `accept: text/html,*/*`, following redirects.
3. Run the shared text audit (the same rules as [Adapter fs](Adapter-fs#text-matching-rules)): an old value from the lock still present is `stale`. Otherwise a current value that is absent is `missing`.

`where` includes a snippet of the extracted text around the first hit, so you can find it on the page. Here the demo's `site` points at a local server whose `/pricing` page still says `$4.99` in both the body and `og:description`, after the fact moved to 5.99:

```text
$ starchart audit --ids web:live-pricing
! stale  web:live-pricing http://127.0.0.1:4511/pricing near "pricing Nebula Pro Now only $4.99 /mo Nebula Pro for $4.99 a month"  still shows old value 4.99 (2 occurrences); expected 5.99
1 checked · 1 diff(s) · 0 error(s) · 0 skipped
```

If the artifact carries no leaf facts, the page is still fetched (so a 404 is still a break) but no text is checked.

## Gone pages are breaks, outages are errors

A page that is gone is drift: the chart says it exists and the world says it doesn't. A page you can't reach right now is a problem with the check, not with the page. The adapter keeps the two apart:

| Failure | Result | Message |
|---|---|---|
| HTTP 404 or 410 | `break` diff | `https://…/pricing: HTTP 404 Not Found` |
| Any other non-2xx (500, 503, 403, …) | thrown, listed under audit **errors** | `https://…/pricing: HTTP 503 Service Unavailable` |
| Network error, DNS failure, TLS error | thrown, listed under audit **errors** | `https://…/pricing: request failed: <reason>` |

Errors still make `audit` exit 1, but they don't show up as a diff and don't pretend the page is broken. The demo's `site` is a placeholder domain, so auditing it offline shows the error path:

```text
error web:live-pricing [url] https://nebula.example.com/pricing: request failed: fetch failed
```

Requests run with the rest of the audit, at most 4 artifacts in flight. There is no per-request timeout beyond what the runtime's `fetch` applies.

## Read-only, always

`capabilities: { read: true, write: false }` and no `apply`. A url artifact that embeds a changed fact is always planned as `manual` (`adapter "url" cannot write`). The usual pattern is to pair it with the fs artifact that produces the page and order the live check after it:

```yaml
- id: web:pricing-page          # fs: apply fixes the source
  binding: { adapter: fs, path: apps/web/app/pricing/page.tsx }
  embeds: [addon:pro.price.usd]

- id: web:live-pricing          # url: audit confirms the deploy
  binding: { adapter: url, url: /pricing }
  embeds: [addon:pro.price.usd]
  after: [web:pricing-page]
```

After you deploy, run `starchart audit --ids web:live-pricing` to confirm the new price is live, then `starchart ack web:live-pricing` to re-pin it.

## See also

- [Adapter fs](Adapter-fs)
- [Audit and Break Detection](Audit-and-Break-Detection)
- [Reality X-Ray](Reality-X-Ray)
- [JSON-LD and SEO](JSON-LD-and-SEO)
- [Adapters Overview](Adapters-Overview)
