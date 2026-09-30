import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planFromDiff, planFromLock } from "../src/api.js";
import { assertSafeRev } from "../src/code/diff.js";
import { looksLikeSecret, redactLiteral } from "../src/code/redact.js";
import { writeCodegen } from "../src/codegen/index.js";
import { buildLock } from "../src/core/lock.js";
import { applyPlan } from "../src/engine/apply.js";
import { resolveInRoot } from "../src/paths.js";
import { buildProject, writeLock } from "../src/project.js";
import { unsafeRegexReason } from "../src/regex-safety.js";
import { parseRules } from "../src/rules/engine.js";
import { serve, type ServeHandle } from "../src/viewer/serve.js";

function project(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "starchart-sec-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

// Assembled at runtime so no credential-shaped literal is committed (secret scanners flag them).
const FAKE_STRIPE_KEY = ["sk", "live", "FAKE0000000000000000000000"].join("_");

const SECRET_REPO = {
  ".starchart/config.yaml": "name: sec\ncode:\n  scopes: { app: . }\n",
  "src/config.ts": [
    `export const STRIPE_KEY = "${FAKE_STRIPE_KEY}";`,
    'export const DB_URL = "postgres://admin:hunter2@db.internal/prod";',
    'export const PRICE_PRO_MONTHLY = "price_1NebulaPro499";',
    "export const PRO_PRICE_USD = 4.99;",
  ].join("\n"),
};

describe("SEC-5: secret-looking literals are redacted from the graph", () => {
  it("withholds credential values but keeps product facts", async () => {
    const p = await buildProject(project(SECRET_REPO));
    const text = JSON.stringify(p.graph.toJSON());
    expect(text).not.toContain(FAKE_STRIPE_KEY);
    expect(text).not.toContain("hunter2");
    expect(p.graph.node("symbol:app/src/config#STRIPE_KEY")?.meta?.redacted).toBe(true);
    expect(p.graph.node("symbol:app/src/config#PRICE_PRO_MONTHLY")?.value).toBe("price_1NebulaPro499");
    expect(p.graph.node("symbol:app/src/config#PRO_PRICE_USD")?.value).toBe(4.99);
  });

  it("detects credentials by name and by format", () => {
    expect(redactLiteral("apiKey", "abc").redacted).toBe(true);
    expect(redactLiteral("CLIENT_SECRET", 1234).redacted).toBe(true);
    expect(redactLiteral("features", ["themes", "ghp_" + "a".repeat(30)]).redacted).toBe(true);
    expect(redactLiteral("proFeatures", ["Themes", "iCloud sync"]).redacted).toBe(false);
    expect(looksLikeSecret("-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(looksLikeSecret("price_1NebulaPro499")).toBe(false);
  });
});

describe("SEC-1/6: the local server only talks to the extension and loopback", () => {
  let server: ServeHandle | undefined;
  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${server!.url}${path}`, { headers });

  it("denies CORS to web origins and grants it to extension origins", async () => {
    server = await serve({ root: project(SECRET_REPO), port: 0 });
    const web = await get("/graph.json", { origin: "https://evil.example" });
    expect(web.headers.get("access-control-allow-origin")).toBeNull();
    const ext = await get("/xray.json", { origin: "chrome-extension://abcdefghijklmnop" });
    expect(ext.headers.get("access-control-allow-origin")).toBe("chrome-extension://abcdefghijklmnop");
    const body = await web.text();
    expect(body).not.toContain("hunter2");
  });

  it("rejects non-loopback Host headers (DNS rebinding)", async () => {
    server = await serve({ root: project(SECRET_REPO), port: 0 });
    const port = new URL(server.url).port;
    // fetch() won't let us spoof Host, so speak raw HTTP
    const { request } = await import("node:http");
    const status = await new Promise<number>((done, fail) => {
      const req = request({ host: "127.0.0.1", port, path: "/graph.json", headers: { host: `evil.example:${port}` } }, (res) => {
        res.resume();
        done(res.statusCode ?? 0);
      });
      req.on("error", fail);
      req.end();
    });
    expect(status).toBe(403);
    expect((await get("/health")).status).toBe(200);
  });

  it("refuses to bind a non-loopback host without allowRemote", async () => {
    await expect(serve({ root: project(SECRET_REPO), port: 0, host: "0.0.0.0" })).rejects.toThrow(/no authentication/);
  });
});

describe("SEC-2: git revisions can't smuggle options", () => {
  it("rejects option-shaped bases before running git", async () => {
    expect(() => assertSafeRev("--output=/tmp/x")).toThrow(/invalid git revision/);
    expect(() => assertSafeRev("origin/main")).not.toThrow();
    const root = project({ ".starchart/config.yaml": "name: g\ncode:\n  scopes: { app: . }\n", "a.ts": "export const A = 1;\n" });
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "base"], { cwd: root });
    const target = join(root, "pwned.txt");
    const p = await buildProject(root);
    await expect(planFromDiff(p, `--output=${target}`)).rejects.toThrow(/invalid git revision/);
    expect(existsSync(target)).toBe(false);
  });
});

describe("SEC-3/4/7: writes stay inside the project, even through symlinks", () => {
  it("refuses a symlink that points outside the root", () => {
    const outer = mkdtempSync(join(tmpdir(), "starchart-outer-"));
    const root = join(outer, "inner");
    mkdirSync(join(root, "web"), { recursive: true });
    writeFileSync(join(outer, "target.txt"), "price 4.99");
    symlinkSync("../../target.txt", join(root, "web/page.txt"));
    expect(() => resolveInRoot(root, "web/page.txt")).toThrow(/outside the project root/);
    expect(() => resolveInRoot(root, "../x")).toThrow(/outside the project root/);
    expect(resolveInRoot(root, "web/new-file.txt")).toBe(join(root, "web/new-file.txt"));
  });

  it("apply does not rewrite a file behind an escaping symlink", async () => {
    const outer = mkdtempSync(join(tmpdir(), "starchart-outer-"));
    const root = join(outer, "inner");
    mkdirSync(join(root, ".starchart"), { recursive: true });
    mkdirSync(join(root, "web"));
    writeFileSync(join(outer, "target.txt"), "price 4.99");
    symlinkSync("../../target.txt", join(root, "web/page.txt"));
    writeFileSync(join(root, ".starchart/config.yaml"), "name: s\ncode:\n  scopes: { app: web }\n");
    const doc = (v: string) => `entities:\n  - id: a:x\n    facts: { price: ${v} }\nartifacts:\n  - id: w:p\n    binding: { adapter: fs, path: web/page.txt }\n    embeds: [a:x.price]\n`;
    writeFileSync(join(root, ".starchart/x.yaml"), doc("4.99"));
    const first = await buildProject(root);
    writeLock(root, buildLock(first.graph));
    writeFileSync(join(root, ".starchart/x.yaml"), doc("5.99"));
    const p = await buildProject(root);
    const report = await applyPlan(p, planFromLock(p), {});
    expect(report.failed?.error).toMatch(/outside the project root/);
    expect(readFileSync(join(outer, "target.txt"), "utf8")).toBe("price 4.99");
  });

  it("codegen refuses an out path outside the root", async () => {
    const root = project({
      ".starchart/config.yaml": "name: c\ncode:\n  scopes: { app: . }\ncodegen:\n  - lang: ts\n    out: ../escaped.ts\n",
      ".starchart/x.yaml": "id: a:x\nfacts: { price: 4.99 }\n",
    });
    const p = await buildProject(root);
    expect(() => writeCodegen(p)).toThrow(/outside the project root/);
    expect(existsSync(join(root, "../escaped.ts"))).toBe(false);
  });
});

describe("follow-ups", () => {
  it("apply --dry-run refuses a codegen out path outside the root", async () => {
    const root = project({
      ".starchart/config.yaml": "name: c\ncode:\n  scopes: { app: . }\ncodegen:\n  - lang: ts\n    out: ../escaped.ts\n",
      ".starchart/x.yaml": "id: a:x\nfacts: { price: 4.99 }\n",
      "gen.ts": "// @starchart generated\n// @starchart anchors a:x.price\nexport const A_X_PRICE = 4.99;\n",
    });
    const first = await buildProject(root);
    writeLock(root, buildLock(first.graph));
    writeFileSync(join(root, ".starchart/x.yaml"), "id: a:x\nfacts: { price: 5.99 }\n");
    const p = await buildProject(root);
    const report = await applyPlan(p, planFromLock(p), { dryRun: true });
    expect(report.failed?.error).toMatch(/outside the project root/);
  });

  it("warns when a code-authority fact points at a redacted symbol", async () => {
    const p = await buildProject(
      project({
        ".starchart/config.yaml": "name: r\ncode:\n  scopes: { app: . }\n",
        ".starchart/x.yaml": "id: a:x\nfacts:\n  key: { authority: code, source: { symbol: app/src/k#API_KEY } }\n",
        "src/k.ts": 'export const API_KEY = "not-really-secret";\n',
      }),
    );
    expect(p.warnings.join("\n")).toMatch(/looks like a secret, so its value is redacted/);
    expect(p.graph.node("a:x.key")?.value).toBeUndefined();
  });
});

describe("SEC-9: catastrophic regexes from config are rejected", () => {
  it("flags nested quantifiers and oversized patterns", () => {
    expect(unsafeRegexReason("(a+)+$")).toMatch(/nested quantifier/);
    expect(unsafeRegexReason("(\\w*b)*")).toMatch(/nested quantifier/);
    expect(unsafeRegexReason("x".repeat(600))).toMatch(/longer than/);
    expect(unsafeRegexReason("^Pro[+]? \\d+(\\.\\d{2})?$")).toBeUndefined();
  });

  it("parseRules reports unsafe patterns", () => {
    const { errors } = parseRules([{ id: "r", select: { kind: "fact" }, require: { value: { pattern: "(a+)+$" } } }]);
    expect(errors.join("\n")).toMatch(/unsafe regular expression/);
  });
});
