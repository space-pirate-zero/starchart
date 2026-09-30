import { existsSync, watch, type FSWatcher } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join, relative, resolve } from "node:path";
import { impactOptions } from "../api.js";
import { findRoot, LOCK_FILE, STARCHART_DIR } from "../config/load.js";
import { computeImpact, explainPath } from "../core/impact.js";
import { buildProject, type Project } from "../project.js";
import { renderViewerHtml, viewerData } from "./html.js";
import { xrayPayload } from "./xray.js";

export interface ServeOptions {
  /** Directory inside the project (default: cwd). */
  root?: string;
  /** Port to listen on (default 4477; 0 picks a free port). */
  port?: number;
  /** Interface to bind (default 127.0.0.1). */
  host?: string;
  /** Rebuild on changes to .starchart/, the lock and code scopes, and live-reload open viewers. */
  watch?: boolean;
  /**
   * Permit binding a non-loopback interface. The server has no authentication, so this exposes
   * the whole chart (facts, code layer, bindings) to anyone who can reach the port.
   */
  allowRemote?: boolean;
}

export interface ServeHandle {
  url: string;
  close: () => Promise<void>;
}

export const DEFAULT_PORT = 4477;
export const DEFAULT_HOST = "127.0.0.1";
const DEBOUNCE_MS = 300;
const IGNORED_SEGMENTS = new Set(["node_modules", ".git", "dist", "build", ".next", ".turbo", "coverage", "DerivedData", ".DS_Store"]);

interface Snapshot {
  project: Project;
  html?: string;
  graphJson?: string;
  xrayJson?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Browser-extension origins (the Reality X-Ray) are the only cross-origin readers allowed. */
const EXTENSION_ORIGIN = /^(?:chrome|moz|safari-web)-extension:\/\/[A-Za-z0-9._-]+$/;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK_HOSTS.has(h) || h.endsWith(".localhost") || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/** Hostname from a Host header ("127.0.0.1:4477", "[::1]:4477", "localhost"). */
function hostnameOf(header: string | undefined): string {
  if (!header) return "";
  const m = /^\[([^\]]+)\](?::\d+)?$/.exec(header) ?? /^([^:]+)(?::\d+)?$/.exec(header);
  return m ? m[1]! : header;
}

/**
 * Per-request access control. Rejects Host headers that are not loopback (DNS rebinding) unless
 * remote access was explicitly allowed, and grants CORS only to browser-extension origins.
 */
function guard(req: IncomingMessage, res: ServerResponse, allowRemote: boolean): void {
  if (!allowRemote && !isLoopbackHost(hostnameOf(req.headers.host))) {
    throw new HttpError(403, "forbidden host");
  }
  const origin = req.headers.origin;
  if (origin && EXTENSION_ORIGIN.test(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  res.setHeader("Vary", "Origin");
}

/** Serves the star chart viewer and the JSON endpoints used by the X-Ray extension. */
export async function serve(opts: ServeOptions = {}): Promise<ServeHandle> {
  const start = resolve(opts.root ?? process.cwd());
  const host = opts.host ?? DEFAULT_HOST;
  const allowRemote = opts.allowRemote === true;
  if (!allowRemote && !isLoopbackHost(host)) {
    throw new Error(`refusing to bind ${host}: the server has no authentication. Use a loopback host, or pass allowRemote (CLI: --allow-remote) to expose the chart on your network.`);
  }
  const port = opts.port ?? DEFAULT_PORT;
  const live = opts.watch === true;

  let cached: Promise<Snapshot> | undefined;
  const sseClients = new Set<ServerResponse>();
  const watchers = new Map<string, FSWatcher>();
  let debounce: NodeJS.Timeout | undefined;
  let closed = false;

  const build = async (): Promise<Snapshot> => {
    const project = await buildProject(start);
    if (live) watchProject(project);
    return { project };
  };

  const snapshot = (): Promise<Snapshot> => {
    if (!live) return build();
    if (!cached) {
      const pending = build();
      cached = pending;
      pending.catch(() => {
        if (cached === pending) cached = undefined;
      });
    }
    return cached;
  };

  const onChange = (path: string | null) => {
    if (closed || (path && ignored(path))) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      cached = undefined;
      // Rebuild eagerly so the next request is fast, then tell open viewers.
      snapshot().then(
        () => broadcast("change"),
        () => broadcast("change"),
      );
    }, DEBOUNCE_MS);
  };

  const addWatcher = (dir: string, recursive: boolean, filter?: (name: string) => boolean) => {
    const key = `${dir}\u0000${recursive}`;
    if (watchers.has(key) || !existsSync(dir)) return;
    try {
      const w = watch(dir, { recursive, persistent: false }, (_event, filename) => {
        const name = filename ? filename.toString() : null;
        if (filter && (!name || !filter(name))) return;
        onChange(name);
      });
      w.on("error", () => {
        w.close();
        watchers.delete(key);
      });
      watchers.set(key, w);
    } catch {
      // Recursive watching is unsupported on some platforms/filesystems; the viewer still works without live reload.
    }
  };

  function watchProject(project: Project) {
    addWatcher(join(project.root, STARCHART_DIR), true);
    addWatcher(project.root, false, (name) => name === LOCK_FILE);
    for (const dir of Object.values(project.loaded.config.code.scopes)) {
      const abs = resolve(project.root, dir);
      if (relative(project.root, abs).startsWith("..")) continue;
      addWatcher(abs, true);
    }
  }

  function broadcast(event: string) {
    for (const res of sseClients) res.write(`event: ${event}\ndata: {}\n\n`);
  }

  if (live) {
    const root = findRoot(start);
    if (root) addWatcher(join(root, STARCHART_DIR), true);
  }

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const method = req.method ?? "GET";
    guard(req, res, allowRemote);
    if (method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Max-Age": "600" });
      res.end();
      return;
    }
    if (method !== "GET" && method !== "HEAD") throw new HttpError(405, `method ${method} not allowed`);
    const url = new URL(req.url ?? "/", "http://localhost");

    switch (url.pathname) {
      case "/":
      case "/index.html": {
        const snap = await snapshot();
        snap.html ??= renderViewerHtml({ ...viewerData(snap.project), live });
        send(res, 200, "text/html; charset=utf-8", snap.html, method);
        return;
      }
      case "/graph.json": {
        const snap = await snapshot();
        snap.graphJson ??= JSON.stringify(snap.project.graph.toJSON());
        send(res, 200, "application/json; charset=utf-8", snap.graphJson, method);
        return;
      }
      case "/xray.json": {
        const snap = await snapshot();
        snap.xrayJson ??= JSON.stringify(xrayPayload(snap.project));
        send(res, 200, "application/json; charset=utf-8", snap.xrayJson, method);
        return;
      }
      case "/impact": {
        const ids = url.searchParams.getAll("id").filter((s) => s.length > 0);
        if (!ids.length) throw new HttpError(400, 'missing "id" query parameter');
        const { project } = await snapshot();
        const unknown = ids.filter((id) => !project.graph.hasNode(id));
        if (unknown.length) throw new HttpError(404, `unknown node: ${unknown.join(", ")}`);
        json(res, 200, impactResponse(project, ids), method);
        return;
      }
      case "/health": {
        const { project } = await snapshot();
        const size = project.graph.size;
        json(res, 200, { ok: true, name: project.loaded.config.name, nodes: size.nodes, edges: size.edges, live }, method);
        return;
      }
      case "/events": {
        if (!live) throw new HttpError(404, "live reload is off (start with watch)");
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
        res.write(": starchart live\n\n");
        sseClients.add(res);
        const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
        ping.unref();
        req.on("close", () => {
          clearInterval(ping);
          sseClients.delete(res);
        });
        return;
      }
      default:
        throw new HttpError(404, `not found: ${url.pathname}`);
    }
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : String(error);
      if (res.headersSent) {
        res.end();
        return;
      }
      json(res, status, { ok: false, error: message }, req.method ?? "GET");
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address() as AddressInfo;
  const displayHost = address.family === "IPv6" || host.includes(":") ? `[${address.address}]` : host;
  const url = `http://${displayHost}:${address.port}`;

  return {
    url,
    close: async () => {
      closed = true;
      if (debounce) clearTimeout(debounce);
      for (const w of watchers.values()) w.close();
      watchers.clear();
      for (const res of sseClients) res.end();
      sseClients.clear();
      await new Promise<void>((resolveClose) => {
        server.close(() => resolveClose());
        server.closeAllConnections();
      });
    },
  };
}

function ignored(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => IGNORED_SEGMENTS.has(segment));
}

export interface ImpactResponseItem {
  id: string;
  label?: string;
  kind: string;
  layer: string;
  class: string;
  reason: string;
  via: string;
  confidence: number;
  depth: number;
  path: { from: string; to: string; type: string }[];
  explain: string;
}

/** Impact of changing `ids`, shaped for HTTP clients. */
export function impactResponse(project: Project, ids: string[]): { seeds: string[]; items: ImpactResponseItem[] } {
  const result = computeImpact(project.graph, ids, impactOptions(project));
  return {
    seeds: result.seeds,
    items: result.items.map((item) => {
      const out: ImpactResponseItem = {
        id: item.id,
        kind: item.node.kind,
        layer: item.node.layer,
        class: item.class,
        reason: item.reason,
        via: item.via,
        confidence: item.confidence,
        depth: item.depth,
        path: item.path,
        explain: explainPath(item.path),
      };
      if (item.node.label !== undefined) out.label = item.node.label;
      return out;
    }),
  };
}

function send(res: ServerResponse, status: number, type: string, body: string, method: string) {
  const headers: Record<string, string> = {
    "Content-Type": type,
    "Content-Length": String(Buffer.byteLength(body)),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (type.startsWith("text/html")) {
    headers["Referrer-Policy"] = "no-referrer";
    headers["X-Frame-Options"] = "DENY";
  }
  res.writeHead(status, headers);
  res.end(method === "HEAD" ? undefined : body);
}

function json(res: ServerResponse, status: number, value: unknown, method: string) {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value), method);
}
