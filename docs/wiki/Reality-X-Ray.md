Reality X-Ray is a browser extension that overlays your STARCHART on the real web. Open your pricing page, App Store listing or checkout, press **SCAN PAGE**, and every fact value on the page lights up: green when it's current, red and tagged **STALE** when the page still shows a value from before your last change, and (opt-in) grey **UNBOUND** for prices no fact accounts for. This page covers installing it in Chrome and Firefox, the popup and options, on-demand versus auto-scan, what the marks and HUD mean, how matching works and where it stops, privacy, and the `xray.json` payload.

> **Status.** Manifest V3, plain JavaScript, no build step. The matcher and payload have automated tests; the content script was exercised in a browser with stubbed extension APIs during development; it has not yet been loaded as a packed extension or published to the Chrome/Firefox stores. You load it unpacked. The tests are `xray-match.test.ts` (for the shared matcher, [`src-shared/match.js`](https://github.com/space-pirate-zero/starchart/blob/main/packages/xray/src-shared/match.js)) and `xray.test.ts` (for the payload).

Source: [`packages/xray`](https://github.com/space-pirate-zero/starchart/blob/main/packages/xray) and [`viewer/xray.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/viewer/xray.ts) (the payload).

## 1. Start the local server

The extension reads from `starchart serve` (see [Viewer and Serve](Viewer-and-Serve)). Run it from your project:

```bash
npx @space-pirate-zero/starchart serve            # http://127.0.0.1:4477
npx @space-pirate-zero/starchart serve --watch    # rebuild when .starchart/, the lock or code change
```

`@space-pirate-zero/starchart` isn't on npm yet. Until it is, build from source (`git clone https://github.com/space-pirate-zero/starchart.git && cd starchart && pnpm install && pnpm build`) and run `node /path/to/starchart/packages/starchart/dist/cli/bin.js serve` from your project. That checkout also holds the `packages/xray` folder you load below.

The extension calls `GET /health` and `GET /xray.json`. The viewer is at `/`.

## 2. Install

**Chrome, Edge, Brave, Arc (Chromium)**

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick the `packages/xray` folder from a STARCHART checkout.
4. Pin **STARCHART X-Ray** to the toolbar.

**Firefox 128+**

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `packages/xray/manifest.json`.

Firefox removes temporary add-ons when it restarts. Load it again next session. The manifest declares the gecko id `xray@starchart.spacepiratezero.com` and `strict_min_version: 128.0`, and lists both a `service_worker` (Chromium) and background `scripts` (Firefox).

## 3. The popup

Click the toolbar icon:

| Element | What it does |
|---|---|
| Status line | `CONNECTED · 111 stars` and the project name, or `NOT CONNECTED` with a hint to run `starchart serve` |
| **SCAN PAGE** | Injects the scanner into the current tab and marks it. Disabled on non-http(s) pages (browser pages are off limits). |
| **CLEAR MARKS** | Removes every mark from the tab |
| **OPEN CHART** | Opens the viewer from your server in a new tab |
| Result | Counts: in sync, stale, unbound (`–` when unbound marking is off) |
| **Mark unbound prices** | Also mark currency amounts no fact explains |
| **Auto-scan matching pages** | Scan automatically when a tab loads a URL that matches an artifact (below) |
| **Settings** | Opens the options page |

## 4. Options: the server URL

The options page holds one setting: the server URL (default `http://127.0.0.1:4477`). **Save** stores it and tests it against `/health`. **Test** tests without saving. **Reset** restores the default.

- Local `http://` servers (`127.0.0.1`, `localhost`, `[::1]`) need no extra permission. `127.0.0.1` and `localhost` are pre-granted in the manifest.
- Any other host (a teammate's machine, a tunnel) triggers a permission request for exactly that host when you save.

## 5. Scan on demand vs auto-scan

**On demand (default).** The extension holds `activeTab` + `scripting`. It can only touch the tab you're looking at, and only when you press **SCAN PAGE**. No content script is registered on any site.

**Auto-scan (opt-in).** Turning the toggle on asks for access to **exactly the origins your artifacts declare**, nothing else. The popup computes that list from `xray.json` and shows it: `Scans pages matching artifact URLs on: https://nebula.example.com, https://apps.apple.com`. The request comes from `optional_host_permissions`. After that, when any tab finishes loading an `http(s)` URL, the background worker:

1. fetches the payload (cached for 5 seconds),
2. checks whether some artifact's URL pattern covers the tab's URL,
3. checks the origin permission is actually granted,
4. injects and scans.

Failures are silent (the server may be down, or the page may forbid injection). Denying the permission leaves auto-scan off.

Artifact URLs come from three places (see [`viewer/xray.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/viewer/xray.ts)):

| Source | Example |
|---|---|
| `binding.url` of a `url`-adapter artifact, relative URLs resolved against `site` | `/pricing` → `https://nebula.example.com/pricing` |
| `meta.urls` on any artifact (relative entries resolved the same way) | `meta: { urls: ["https://docs.example.com/billing/*"] }` |
| every `appstore`-adapter artifact | `https://apps.apple.com/*` |

URL matching: a pattern with `*` is a wildcard match against the full URL. A plain URL covers itself and everything below it, ignoring query, hash and trailing slash (`https://x.com/pricing` covers `https://x.com/pricing/?plan=pro`).

Relative URLs resolve exactly like the [url adapter](Adapter-url): leading slashes are stripped and the rest is joined onto `site` with a trailing `/`, so the site's base path is kept. With `site: https://example.com/app`, `/pricing` becomes `https://example.com/app/pricing` for both the adapter and X-Ray. Absolute `http(s)://` URLs are used as-is. A relative URL with no `site` configured is dropped.

## 6. What the marks mean

| Mark | Meaning |
|---|---|
| **Green** | The page shows a fact's **current** value. In sync. |
| **Red, tagged STALE** | The page shows a fact's **previous** value: the one pinned in `starchart.lock` before your change. Something didn't get updated. |
| **Grey, tagged UNBOUND** (opt-in) | A currency amount that matches no fact (`$29.00`, `€1.299,00`, `12 USD`). Either an unmodeled price or a typo. |

"Previous" only exists while the fact differs from the lock. Once you apply or `ack` and the lock moves, there's nothing to call stale. X-Ray answers "does this page still show what we had before this change?", not "is it wrong in general".

Hover a mark (or focus it with Tab) for a tooltip: the fact id, current value, what the page shows, and the artifacts linked to the fact. Click it, or press Enter, to open that fact in the viewer (`/#<fact-id>`).

## 7. The HUD

After a scan, a draggable panel appears in the top-right corner:

- counts: in sync, stale, unbound
- **THIS PAGE IS**: artifacts whose URL matches this page, each marked `· in sync` or `· STALE` (artifact staleness from the lock, the same as `starchart check`)
- **STALE ON THIS PAGE**: up to 12 stale marks as buttons that scroll to them (`4.99 → addon:pro.price.usd`)
- **METADATA**: matches in `<title>`, `og:title`, `og:description`, `description`, `twitter:title`, `twitter:description` and JSON-LD blocks, which aren't visible on the page but matter to crawlers and link previews
- a **Mark unbound prices** toggle, and **RESCAN**, **CLEAR** and **OPEN CHART** buttons

`Esc` closes the HUD. If the server is unreachable, the HUD shows the error and `Start the server with: starchart serve`.

**CLEAR** removes every mark and puts the original text nodes back exactly where they were.

## 8. How matching works

The matcher is `src-shared/match.js`: pure, DOM-free, and shared by the content script, the background worker and the test suite.

Facts come from the payload: each leaf fact's current value, plus its previous value when the lock differs. Numbers are stringified with `String(value)`, strings are trimmed. Values shorter than 2 characters are ignored.

Rules:

- **Numbers match on token boundaries.** `4.99` never matches inside `14.99`, `4.995` or `1.4.99`, but does match in `costs 4.99.` (a trailing sentence period is fine).
- **Words match on word boundaries.** `Pro` never matches inside `Protect`.
- **Currency symbols are included in the mark.** For `$5.99` the mark covers the `$` too (`$ € £ ¥ ₹`).
- **Longer values win.** `Pro+` claims its span before `Pro` can. Marks never overlap.
- **Current beats stale.** A value that is current for any fact counts as in sync, even if it's another fact's old value. In the demo after bumping USD to 5.99, `4.99` is the previous USD price but still the current EUR price, so a `4.99` on the page is green.
- **Whitespace is flexible.** A space inside a value matches any whitespace run, including no-break spaces.

What gets scanned: visible text nodes only. Skipped: `script`, `style`, `noscript`, `textarea`, `input`, `select`, `option`, `template`, `iframe`, `canvas`, `svg`, `math`, `contenteditable` regions, hidden elements (`display: none`, `visibility: hidden`, no layout boxes), and the X-Ray UI itself.

### Limits (it's textual)

- **Formatting must match.** A fact of `6` does not match `6.00` on the page, and a fact of `5.99` does not match `5,99 €`, `$6` or localized digits. (The fs and url adapters are a bit more forgiving: they also try a number's two-decimal form. X-Ray does not.)
- **Single-page apps** that re-render after the scan can drop or duplicate marks. Press **RESCAN**. Marking replaces text nodes, so a framework holding references to them may re-render that part of the page.
- **Closed shadow roots and cross-origin iframes** are not scanned.
- **Unbound detection** is a heuristic regex for amounts with a currency symbol or code (`USD`, `EUR`, `GBP`, `CAD`, `AUD`, `JPY`). A bare `29` isn't a price as far as it knows.

## 9. Privacy

- The extension talks to **one server: yours**. The default is `http://127.0.0.1:4477`. It sends no analytics and makes no other network calls.
- **Pages never talk to the server.** The background worker fetches `/xray.json`, so the page's scripts can't see your chart, and page CSP or mixed-content rules don't get in the way.
- Nothing is injected until you press **SCAN PAGE**, or until you turn on auto-scan *and* grant specific origins.
- `storage` holds only the server URL and the two toggles.

| Permission | Why |
|---|---|
| `activeTab` + `scripting` | Inject the scanner into the tab you're looking at, when you press SCAN PAGE |
| `storage` | Remember the server URL and toggles |
| `http://127.0.0.1/*`, `http://localhost/*` | Talk to `starchart serve` |
| optional site access (`https://*/*`, `http://*/*` declared, requested per origin) | Only for auto-scan, and only for the origins your artifacts declare, or for a non-local server URL |

One caveat on the server side: `starchart serve` answers with `Access-Control-Allow-Origin: *`, so while it runs any page in your browser could fetch your chart from localhost. That's a property of the server, not the extension. See [Viewer and Serve](Viewer-and-Serve#cors-and-headers).

## 10. The xray.json payload

`GET /xray.json` (or `starchart emit xray`) returns:

```ts
export interface XrayPayload {
  name: string;
  generatedAt: string;
  facts: XrayFact[];
  artifacts: XrayArtifact[];
  /** Every previous (stale) value, for quick "does this page show an old value" checks. */
  staleValues: string[];
}

export interface XrayFact {
  id: string;
  /** Current value, stringified as a page would display it. */
  value: string;
  /** The locked value when it differs from the current one: what stale pages still show. */
  previous?: string;
  /** Artifacts that embed, mirror or render this fact (or one of its ancestors). */
  artifacts: string[];
}

export interface XrayArtifact {
  id: string;
  label?: string;
  /** URL patterns where this artifact is visible; "*" is a wildcard. */
  urls: string[];
  stale: boolean;
  adapter?: string;
  /** How the artifact depends on facts (embeds / mirrors / renders), a hint for auto-fixability. */
  edges: EdgeType[];
}
```

Only leaf facts with a displayable value (a finite number or a non-blank string) are included. Booleans, objects and arrays are left out. A fact's `artifacts` include artifacts attached to any ancestor, so an artifact that mirrors `addon:pro.price` shows up under `addon:pro.price.usd`.

From the demo after changing `usd` to 5.99 (trimmed to three facts and three artifacts):

```json
{
  "name": "pro-universe",
  "generatedAt": "2026-09-29T22:51:19.341Z",
  "facts": [
    {
      "id": "addon:pro.name",
      "value": "Nebula Pro",
      "artifacts": ["appstore:listing/description", "stripe:price/pro-monthly", "web:messages-en", "web:og-pro"]
    },
    {
      "id": "addon:pro.price.eur",
      "value": "4.99",
      "artifacts": ["appstore:iap/pro-monthly"]
    },
    {
      "id": "addon:pro.price.usd",
      "value": "5.99",
      "artifacts": [
        "appstore:iap/pro-monthly", "appstore:listing/description", "appstore:screenshots/6.9/03",
        "email:onboarding-day-3", "reel:spring-2026", "stripe:price/pro-monthly", "web:live-pricing",
        "web:messages-en", "web:og-pro", "web:pricing-page"
      ],
      "previous": "4.99"
    }
  ],
  "artifacts": [
    {
      "id": "appstore:listing/description",
      "urls": ["https://apps.apple.com/*"],
      "stale": true,
      "edges": ["embeds"],
      "label": "App Store description (en-US)",
      "adapter": "appstore"
    },
    {
      "id": "web:live-pricing",
      "urls": ["https://nebula.example.com/pricing"],
      "stale": true,
      "edges": ["embeds"],
      "label": "Live pricing page",
      "adapter": "url"
    },
    {
      "id": "web:pricing-page",
      "urls": [],
      "stale": true,
      "edges": ["embeds"],
      "label": "Pricing page",
      "adapter": "fs"
    }
  ],
  "staleValues": ["4.99"]
}
```

`staleValues` lists every previous value, even one that's still current for another fact (`4.99` here is also the EUR price). The matcher resolves that in favor of "in sync".

## Regenerating icons

`icons/*.png` are generated:

```bash
node packages/xray/scripts/make-icons.mjs
```

## See also

- [Viewer and Serve](Viewer-and-Serve)
- [Adapter url](Adapter-url)
- [Lockfile and Drift](Lockfile-and-Drift)
- [Audit and Break Detection](Audit-and-Break-Detection)
