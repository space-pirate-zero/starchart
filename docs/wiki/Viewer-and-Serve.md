The star chart, literally. `starchart graph` writes a single self-contained HTML file you can open anywhere. `starchart serve` runs the same viewer from a local server, adds JSON endpoints for scripts and the [Reality X-Ray](Reality-X-Ray) extension, and with `--watch` live-reloads the page when your chart changes. This page covers both commands, every HTTP route, the viewer's features and keyboard shortcuts, live reload, and performance notes.

Sources: [`viewer/html.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/viewer/html.ts), [`viewer/serve.ts`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/viewer/serve.ts), [`viewer/assets/viewer.js`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/viewer/assets/viewer.js), [`viewer/assets/impact-core.js`](https://github.com/space-pirate-zero/starchart/blob/main/packages/starchart/src/viewer/assets/impact-core.js).

Examples below write `starchart <cmd>`. Once the package is published that's `npx @spz/starchart <cmd>`; until then it's `node /path/to/starchart/packages/starchart/dist/cli/bin.js <cmd>` from a source build (see [Getting Started](Getting-Started)).

## starchart graph

```bash
starchart graph                     # writes ./starchart.html
starchart graph -o docs/chart.html
```

| Option | Default | Meaning |
|---|---|---|
| `-o, --out <file>` | `starchart.html` | Output path, relative to the current directory. Parent directories are created. |

```text
$ starchart graph -o chart.html
✓ chart.html
```

The file is fully self-contained: inline CSS, inline JavaScript, the graph embedded as JSON in a `<script type="application/json">` element. No CDN, no fonts, no network. The demo's chart is about 145 KB. A strict Content Security Policy is baked in: scripts and styles are allowed only by their SHA-256 hashes, plus `connect-src 'self'`, `img-src data:`, `base-uri 'none'` and `form-action 'none'`. All node text goes through `textContent`, and the embedded JSON escapes `<`, `>` and `&`, so hostile labels can't inject markup.

It's a snapshot: it shows the graph, stale set and lock values as of the moment you ran the command. Commit it, attach it to a PR, or publish it with your docs.

## starchart serve

```bash
starchart serve                     # http://127.0.0.1:4477
starchart serve -p 8080 --watch
starchart serve --host 0.0.0.0      # expose on your network (read below first)
```

| Option | Default | Meaning |
|---|---|---|
| `-p, --port <port>` | `4477` | Port to listen on |
| `--host <host>` | `127.0.0.1` | Interface to bind. IPv6 addresses print in brackets. |
| `-w, --watch` | off | Rebuild on changes and live-reload open viewers |

```text
$ starchart serve -p 4499 --watch
★ STARCHART at http://127.0.0.1:4499  (ctrl+c to stop)
```

Ctrl+C (or SIGTERM) closes the watchers, the live-reload streams and the server.

Without `--watch`, every request rebuilds the project from disk, so responses are always current but slower on big repos. With `--watch`, the build is cached and rebuilt only when something changes.

Each build is the same one the CLI does, including plugins listed under `plugins:` in `config.yaml`. Custom adapters therefore count toward write access in `/impact` and the viewer, and a plugin that fails to load makes the build fail (a `500` from the routes). Unlike other commands, `serve` doesn't print code-ingest warnings; run `starchart check` or any other command to see them on stderr.

### Routes

Only `GET` and `HEAD` are allowed (plus `OPTIONS` preflight). Anything else is `405`.

| Route | Returns |
|---|---|
| `/`, `/index.html` | The viewer HTML. The same page as `starchart graph`, plus live reload when `--watch` is on. |
| `/graph.json` | The raw serialized graph (`{ nodes, edges }`), the same as `starchart emit graph` |
| `/impact?id=<node>` | Impact of changing one or more nodes. Repeat `id` for several seeds. |
| `/xray.json` | The Reality X-Ray payload, the same as `starchart emit xray` (see [Reality X-Ray](Reality-X-Ray#10-the-xrayjson-payload)) |
| `/health` | `{ ok, name, nodes, edges, live }` |
| `/events` | Server-Sent Events stream for live reload. Only with `--watch`, otherwise `404`. |

Errors are JSON: `{ "ok": false, "error": "…" }` with status `400` (missing `id`), `404` (unknown route or node), `405` or `500`.

Real responses from the demo:

```text
$ curl -s http://127.0.0.1:4499/health
{"ok":true,"name":"pro-universe","nodes":111,"edges":182,"live":true}

$ curl -s "http://127.0.0.1:4499/impact?id=addon:pro.name"
{"seeds":["addon:pro.name"],"items":[{"id":"addon:pro","kind":"entity","layer":"fact","class":"info","reason":"derived fact changes","via":"partOf","confidence":1,"depth":1,"path":[{"from":"addon:pro.name","to":"addon:pro","type":"partOf"}],"explain":"addon:pro.name --partOf--> addon:pro","label":"Nebula Pro"},{"id":"appstore:listing/description","kind":"artifact","layer":"world","class":"manual","reason":"adapter \"appstore\" cannot write",…

$ curl -s "http://127.0.0.1:4499/impact"
{"ok":false,"error":"missing \"id\" query parameter"}

$ curl -s "http://127.0.0.1:4499/impact?id=nope"
{"ok":false,"error":"unknown node: nope"}
```

Each `/impact` item has `id`, `label?`, `kind`, `layer`, `class`, `reason`, `via`, `confidence`, `depth`, `path` and `explain`. `/impact` runs the core impact code with the project's adapter settings, including per-binding checks such as the App Store adapter's `canApply` (only `field` bindings are writable), so `auto` vs `manual` matches `starchart plan`. See [Impact Analysis](Impact-Analysis).

### CORS and headers

Every response carries `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET, HEAD, OPTIONS` and `Access-Control-Allow-Headers: Content-Type`. Preflight answers `204` with `Access-Control-Max-Age: 600`. Everything is `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. The HTML also gets `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`.

The open CORS policy means **any web page open in your browser can read your chart** from `http://127.0.0.1:4477` while `serve` runs. It's read-only, but it includes fact values, file paths and lock values. That's fine for a local dev tool bound to loopback. Think twice before `--host 0.0.0.0`: there is no authentication.

## Live reload (`--watch`)

With `--watch`, the server watches:

- `.starchart/` (recursive)
- `starchart.lock` in the project root
- every code scope from `code.scopes` in config (recursive), if it's inside the project

Paths containing `node_modules`, `.git`, `dist`, `build`, `.next`, `.turbo`, `coverage`, `DerivedData` or `.DS_Store` are ignored. Changes are debounced by 300 ms. The server then rebuilds eagerly and sends `event: change` on `/events`. Open viewers save their view (camera, layer toggles, "show all code", impact mode, hidden edge types) to `sessionStorage`, flash **CHART UPDATED — RELOADING**, and reload into the same view. The stream sends a keep-alive comment every 25 seconds.

Recursive `fs.watch` isn't supported on every platform and filesystem. Where it fails, the viewer still works, just without live reload.

## The viewer

### Three bands

The canvas is split into three horizontal bands, top to bottom: **WORLD** (pink, artifacts), **FACTS** (yellow, entities and facts), **CODE** (green, files, symbols, routes, screens, tests…). A force layout keeps every star inside its band, so cross-layer edges (bridges, cyan) visibly cross the dashed band borders. Star size grows with degree. The header shows counts per layer, total edges (hover for how many are bridges) and the number of stale artifacts. The STALE counter lights up when it's above zero.

### Default visibility

Code graphs are huge, so the default view shows the **surface**:

- every world and fact node
- every code node that isn't a `file` or `symbol` (routes, screens, tests, packages, env vars, flags, events…)
- `symbol` nodes that have at least one bridge edge to another layer (a constant that anchors a fact, say)

**SHOW ALL CODE** adds every file and symbol. The **WORLD / FACTS / CODE** chips hide or show a whole band. Selecting a hidden star (from search or a link) reveals it next to its neighbors without a full relayout. Impact mode reveals up to 300 hidden stars that impact paths run through.

### Search

Press `/` (or click the box). Matching is case-insensitive over id and label: id substring matches rank highest (with a bonus at the start or after `:`, `/` or `.`), then label matches, then a fuzzy subsequence match. The top 10 results are shown. `↑` / `↓` move, `Enter` selects, `Esc` closes.

### Side panel

Selecting a star opens the details panel:

- kind badge, a **stale** badge if applicable, id and label
- **VALUE** for facts and code constants
- **LOCKED VALUE (WHAT THE WORLD WAS SYNCED TO)** when the lock's value differs from the current one
- **FIELDS**: authority, status, validThrough, hash, types, owners, tags, location, degree
- **BINDING**, **SOURCE** and **META** as JSON
- **OUTGOING** and **INCOMING** edges grouped by type, with confidence percentages below 100%. Every linked id is clickable. Groups show up to 200 links, then "+N more".
- **← BACK** walks your selection history (up to 50 steps)

Selection is mirrored in the URL hash (`starchart.html#addon%3Apro.price.usd`), so you can link straight to a star.

### Impact mode

Press `i` or click **IMPACT**, then select a star. The viewer runs the same impact algorithm as the CLI (a browser port in `impact-core.js`, configured by the server with your writable adapters and `maxCodeDepth`) and:

- colors impact paths by class: break red, manual orange, review yellow, auto-fix green, code change cyan, tests purple, retire grey, also-affected light grey
- adds **IMPACT · N DOWNSTREAM** to the panel, with class chips and a group per class. Each item shows its reason and why-path. Items below 50% confidence fold into a "low-confidence" disclosure.
- adds the item's class and reason to the hover tooltip

The server passes the port both the writable adapters and the artifacts whose binding an adapter refuses (`canApply`), so the viewer classifies exactly like `starchart plan`: with `adapters.appstore.write: true` an App Store IAP stays `manual` ("appstore cannot update this binding; update it by hand"), and constants holding an artifact's external id get the same "holds this artifact's external id" reason. A parity test keeps the port and the core in lockstep.

A star with nothing downstream says so: "Nothing downstream. Changing this star touches nothing else in the chart." `Esc` clears the selection first, then turns impact mode off.

### Stale pulse

Artifacts whose locked dependencies moved (the same set as `starchart check`) get a pulsing ring, and their tooltip says **● STALE — locked dependencies moved**. The pulse repaints at about 30 fps only while a stale star is visible.

### Legend

The **EDGES** legend (bottom corner) lists every edge type present with its count, colored by category (bridge, world, fact, code). Click a type to hide or show those edges. The legend starts open on screens at least 1200×760 and collapsed on smaller ones.

### Mouse

| Action | Effect |
|---|---|
| Drag | Pan |
| Wheel | Zoom at the cursor (pinch-zoom with ctrl is faster) |
| Hover | Tooltip: id, kind, layer, degree, label, value, stale status |
| Click a star | Select it |
| Double-click a star | Center on it |
| Double-click empty space | Zoom in |
| `+` / `−` / **FIT** buttons | Zoom, fit |

### Keyboard shortcuts

From `viewer.js`. Shortcuts are ignored while typing in an input and when ctrl, alt or meta is held.

| Key | Action |
|---|---|
| `/` | Focus search |
| `i` / `I` | Toggle impact mode |
| `f` / `F` | Fit the chart to the screen |
| `+` or `=` | Zoom in |
| `-` or `_` | Zoom out |
| `n` / `N` | Select the next visible star (bands top to bottom, then left to right) |
| `p` / `P` | Select the previous visible star |
| `Esc` | Clear the selection, or leave impact mode if nothing is selected |
| Arrow keys (chart focused) | Pan |
| `Enter` (chart focused, star selected) | Move focus into the panel's first button |
| `↑` / `↓` / `Enter` / `Esc` (in search) | Navigate, choose, close results |

### Accessibility and reduced motion

A skip link jumps to search. The canvas has a descriptive label and is focusable. Search is an ARIA combobox. Layer chips, toggles and legend items expose `aria-pressed`. Selections and mode changes are announced through a polite live region.

With `prefers-reduced-motion: reduce`, the layout settles without animating, the starfield background stops twinkling, stale rings are drawn static instead of pulsing, and camera moves jump instead of easing. Changing the OS setting while the page is open takes effect immediately.

## Performance notes

- The layout runs on the main thread in slices of about 14 ms per frame, so the page stays responsive while charting. The status line shows `CHARTING N STARS…`.
- Iterations scale with size: 320 ticks up to 1,000 visible stars, 220 up to 3,000, 150 beyond. Re-layouts after toggles are warm starts at 60%.
- In a background tab the layout continues on macrotasks instead of animation frames, so it finishes even when you're not looking.
- Only the default-visible stars take part in the layout. "SHOW ALL CODE" on a large monorepo can multiply the star count. Turn it on when you need it.
- Labels are capped at 320 per frame and drawn only when zoomed in (or for neighbors of the selection and impact items).
- `serve` without `--watch` rebuilds the project on every request. Use `--watch` for repeated access on big repos, since it caches one build.

## See also

- [Reality X-Ray](Reality-X-Ray)
- [Impact Analysis](Impact-Analysis)
- [Three-Layer Model](Three-Layer-Model)
- [Lockfile and Drift](Lockfile-and-Drift)
- [CLI Reference](CLI-Reference)
