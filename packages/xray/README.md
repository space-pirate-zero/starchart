# STARCHART X-Ray

Browse your own website, App Store page or checkout and see every fact your STARCHART knows about light up in place:

- **green**: the page shows the current value (in sync)
- **red, tagged STALE**: the page still shows an old value (the one pinned in `starchart.lock`)
- **grey, tagged UNBOUND** (opt-in): a price on the page that no fact accounts for

Hover a mark for the fact id, the current value, what the page shows and the artifacts linked to that fact. Click it (or focus it and press Enter) to open the fact in the STARCHART viewer. A draggable HUD in the top-right corner lists the counts, which artifact the current page is, the stale values found, and matches in `og:title` / `og:description` / `<title>` / JSON-LD. Press Escape to close it. **CLEAR** removes every mark and puts the original text nodes back exactly as they were.

Plain JavaScript, Manifest V3, no build step and no dependencies.

## 1. Start the local server

From your project (the directory holding `.starchart/`):

```sh
npx starchart serve            # http://127.0.0.1:4477
npx starchart serve --watch    # rebuilds and live-reloads when .starchart/, the lock or code change
```

The extension reads `GET /health` and `GET /xray.json` from the server. The viewer is at `/`.

## 2. Load the extension

**Chrome / Edge / Brave / Arc**

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked** and pick this `packages/xray` folder.
4. Pin **STARCHART X-Ray** to the toolbar.

**Firefox (128+)**

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `packages/xray/manifest.json`.

## 3. Use it

1. Open the page you want to check.
2. Click the X-Ray icon. The popup shows whether the server is reachable and which project it serves.
3. Press **SCAN PAGE**.

Toggles in the popup:

- **Mark unbound prices** also marks currency amounts (`$29.00`, `€1.299,00`, `12 USD`) that match no fact.
- **Auto-scan matching pages** scans automatically when a tab finishes loading a URL that matches an artifact URL. Turning it on asks for access to exactly the sites your artifacts declare, nothing else.

Artifact URLs come from `binding.url` on `url`-adapter artifacts (relative URLs resolve against `site` in `.starchart/config.yaml`), from `meta.urls`, and `https://apps.apple.com/*` for `appstore` artifacts.

**Settings** (in the popup footer, or the extension's options page) changes the server URL. Local servers (`127.0.0.1`, `localhost`) need no extra permission. Any other host is requested when you save.

## Permissions

| Permission | Why |
|---|---|
| `activeTab` + `scripting` | Inject the scanner into the tab you are looking at, only when you press SCAN PAGE |
| `storage` | Remember the server URL and toggles |
| `http://127.0.0.1/*`, `http://localhost/*` | Talk to `starchart serve` |
| optional site access | Only for auto-scan, and only for the origins your artifacts declare |

Content scripts are never registered on every site. Pages never talk to the server: the background worker fetches `/xray.json`, so page CSP and mixed-content rules do not get in the way.

## How matching works

`src-shared/match.js` is a pure, DOM-free matcher shared by the content script, the background worker and the test suite (`packages/starchart/src/viewer/xray-match.test.ts`):

- numbers match on token boundaries: `4.99` never matches inside `14.99`, `4.995` or `1.4.99`, but does match in `costs 4.99.`
- words match on word boundaries: `Pro` never matches inside `Protect`
- longer values win: `Pro+` claims its span before `Pro` can
- a value that is current for any fact counts as in sync, even if it is another fact's old value
- whitespace inside a value matches any whitespace run, including no-break spaces
- values shorter than two characters are ignored

Text inside `script`, `style`, `noscript`, form fields, `contenteditable` regions, SVG and hidden elements is skipped.

## Icons

`icons/*.png` are generated. To regenerate them:

```sh
node scripts/make-icons.mjs
```

## Limitations

- Matching is textual. A value rendered differently from its fact (`$6` for `6.00`, `5,99 €` for `5.99`, localized digits) is not recognized.
- Pages that re-render after the scan (single-page apps) can drop or duplicate marks. Press **RESCAN**. Marking replaces text nodes, so a framework that holds references to them may re-render that part of the page.
- Text inside closed shadow roots and cross-origin iframes is not scanned.
