import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { SESSION_ID, type Hub } from "./hub.ts";
import { validFile, type SceneStore } from "./scene-store.ts";
import { StatusError, type CharacterStore } from "./characters.ts";

/** Connect-style middleware, e.g. Vite's dev server in middleware mode. */
export type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

export interface AppServerOptions {
  hub: Hub;
  scenes: SceneStore;
  characters: CharacterStore;
  token: string;
  /** Built frontend (dist/web). Ignored when `middleware` is given. */
  webRoot?: string;
  middleware?: Middleware;
  host?: string;
}

export interface AppServer {
  readonly server: Server;
  readonly port: number;
  listen(port: number): Promise<void>;
  close(): Promise<void>;
}

/** Cookies ignore the port, so the name carries it: two boards never clobber each other. */
export const cookieName = (port: number) => `excaliagent_token_${port}`;
/** The token is stable per state dir (token.ts), so the cookie may outlive a restart. */
const COOKIE_MAX_AGE = 365 * 24 * 3600;
const MAX_BODY = 50 * 1024 * 1024;
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function sameToken(a: string | undefined, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function cookieToken(req: IncomingMessage, port: number): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === cookieName(port)) return v.join("=");
  }
  return undefined;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function text(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

/** Body limits of the character and pack routes: an image upload, everything else. */
export const IMAGE_BODY_LIMIT = 1536 * 1024;
export const SMALL_BODY_LIMIT = 64 * 1024;

async function readJson(req: IncomingMessage, limit = MAX_BODY): Promise<unknown> {
  if (!(req.headers["content-type"] ?? "").startsWith("application/json")) {
    throw new HttpError(415, "expected application/json");
  }
  // Refuse a declared oversize body before reading any of it.
  if (Number(req.headers["content-length"] ?? 0) > limit) throw new HttpError(413, "body too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON");
  }
}

export function createAppServer(opts: AppServerOptions): AppServer {
  const host = opts.host ?? "127.0.0.1";
  let port = 0;
  const allowedHosts = () => new Set([`${host}:${port}`, `127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = () => new Set([...allowedHosts()].map((h) => `http://${h}`));

  async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string) {
    const root = opts.webRoot;
    if (!root) return text(res, 404, "not found");
    let rel: string;
    try {
      rel = decodeURIComponent(pathname);
    } catch {
      return text(res, 400, "bad path");
    }
    if (rel === "/" || rel === "") rel = "/index.html";
    const file = normalize(join(root, rel));
    if (!file.startsWith(normalize(root) + sep)) return text(res, 404, "not found");
    try {
      if (!(await stat(file)).isFile()) return text(res, 404, "not found");
      const body = await readFile(file);
      res.writeHead(200, {
        "content-type": TYPES[extname(file)] ?? "application/octet-stream",
        "cache-control": rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-store",
      });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      text(res, 404, "not found");
    }
  }

  function events(req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    const send = (sessions: unknown) => res.write(`event: sessions\ndata: ${JSON.stringify(sessions)}\n\n`);
    send(opts.hub.sessions());
    const unsubscribe = opts.hub.subscribe(send);
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }

  /** GET /api/packs/<pack>/<file>: a custom pack's image, only if that pack lists it. */
  async function packImage(res: ServerResponse, rest: string, version: string | null) {
    const parts = rest.split("/");
    if (parts.length !== 2) return json(res, 404, { error: "not found" });
    let pack: string, file: string;
    try {
      [pack, file] = parts.map((p) => decodeURIComponent(p)) as [string, string];
    } catch {
      throw new HttpError(400, "bad path");
    }
    const img = await opts.characters.readImage(pack, file);
    if (!img) return json(res, 404, { error: "not found" });
    res.writeHead(200, {
      "content-type": img.mimeType,
      // `?v=<content hash>` (from the pack listing) names these exact bytes.
      "cache-control": version === img.hash ? "private, max-age=31536000, immutable" : "no-store",
      "x-content-type-options": "nosniff",
      // An SVG opened directly must not run scripts on our origin.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
    res.end(img.bytes);
  }

  async function api(req: IncomingMessage, res: ServerResponse, pathname: string, search: URLSearchParams) {
    const route = `${req.method} ${pathname}`;
    if (req.method === "GET" && pathname.startsWith("/api/packs/")) return packImage(res, pathname.slice("/api/packs/".length), search.get("v"));
    const chars = opts.characters;
    const body = async () => {
      const b = await readJson(req, pathname === "/api/packs/image" ? IMAGE_BODY_LIMIT : SMALL_BODY_LIMIT);
      if (!b || typeof b !== "object") throw new HttpError(400, "expected a JSON object");
      return b as Record<string, unknown>;
    };
    switch (route) {
      case "GET /api/characters":
        return json(res, 200, await chars.load());
      case "POST /api/characters/assign": {
        const b = await body();
        return json(res, 200, await chars.assign(b.pack as string, b.assign as Record<string, string>));
      }
      case "POST /api/characters/override": {
        const b = await body();
        return json(res, 200, await chars.override(b.sessionId as string, (b.character ?? null) as never));
      }
      case "POST /api/characters/active":
        return json(res, 200, await chars.setActive((await body()).pack as string));
      case "POST /api/packs": {
        const b = await body();
        return json(res, 200, await chars.createPack(b.name as string, (b.from ?? undefined) as string | undefined));
      }
      case "POST /api/packs/rename": {
        const b = await body();
        return json(res, 200, await chars.renamePack(b.pack as string, b.name as string));
      }
      case "POST /api/packs/delete":
        return json(res, 200, await chars.deletePack((await body()).pack as string));
      case "POST /api/packs/emoji": {
        const b = await body();
        return json(res, 200, await chars.addEmoji(b.pack as string, b.emoji as string));
      }
      case "POST /api/packs/image": {
        const b = await body();
        return json(res, 200, await chars.addImage(b.pack as string, b.name as string, b.dataURL as string));
      }
      case "POST /api/packs/remove": {
        const b = await body();
        return json(res, 200, await chars.removeCharacter(b.pack as string, b.id as string));
      }
      case "GET /api/sessions":
        return json(res, 200, opts.hub.sessions());
      case "GET /api/events":
        return events(req, res);
      case "GET /api/picker":
        return json(res, 200, await opts.hub.picker());
      case "POST /api/lookup": {
        const body = (await readJson(req)) as { ids?: unknown };
        if (!Array.isArray(body?.ids) || !body.ids.every((i) => typeof i === "string")) {
          throw new HttpError(400, "ids must be a string array");
        }
        return json(res, 200, await opts.hub.lookup(body.ids));
      }
      case "GET /api/scene":
        return json(res, 200, await opts.scenes.load());
      case "PUT /api/scene": {
        const body = (await readJson(req)) as { elements?: unknown; appState?: unknown };
        if (!body || !Array.isArray(body.elements)) throw new HttpError(400, "elements must be an array");
        const appState = body.appState && typeof body.appState === "object" ? body.appState : {};
        await opts.scenes.save({ elements: body.elements, appState: appState as Record<string, unknown> });
        res.writeHead(204).end();
        return;
      }
      case "PUT /api/files": {
        const body = (await readJson(req)) as { files?: unknown };
        if (!Array.isArray(body?.files)) throw new HttpError(400, "files must be an array");
        const bad = body.files.map(validFile).find((f) => f instanceof Error);
        if (bad) throw new HttpError(400, bad.message);
        await opts.scenes.saveFiles(body.files);
        res.writeHead(204).end();
        return;
      }
      case "POST /api/files/get": {
        const body = (await readJson(req)) as { ids?: unknown };
        if (!Array.isArray(body?.ids) || !body.ids.every((i) => typeof i === "string")) {
          throw new HttpError(400, "ids must be a string array");
        }
        return json(res, 200, await opts.scenes.loadFiles(body.ids));
      }
      case "POST /api/end": {
        const body = (await readJson(req)) as { sessionId?: unknown };
        if (typeof body?.sessionId !== "string" || !SESSION_ID.test(body.sessionId)) {
          throw new HttpError(400, "sessionId must be a session id");
        }
        const result = await opts.hub.end(body.sessionId);
        if (result === "ended") {
          res.writeHead(204).end();
          return;
        }
        if (result === "unsupported") return json(res, 501, { error: "unsupported" });
        return json(res, 409, { error: "not running" });
      }
      case "POST /api/focus": {
        const body = (await readJson(req)) as { sessionId?: unknown };
        if (typeof body?.sessionId !== "string") throw new HttpError(400, "sessionId required");
        if (await opts.hub.focus(body.sessionId)) {
          res.writeHead(204).end();
          return;
        }
        return json(res, 409, { error: "no pane" });
      }
      case "POST /api/resume": {
        const body = (await readJson(req)) as { sessionId?: unknown };
        if (typeof body?.sessionId !== "string" || !SESSION_ID.test(body.sessionId)) {
          throw new HttpError(400, "sessionId must be a session id");
        }
        const result = await opts.hub.resume(body.sessionId);
        if (result === "resumed") {
          res.writeHead(204).end();
          return;
        }
        if (result === "unknown") return json(res, 404, { error: "unknown session" });
        return json(res, 409, { error: result === "live" ? "live" : "no herdr" });
      }
      default:
        return json(res, 404, { error: "not found" });
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!allowedHosts().has(req.headers.host ?? "")) return text(res, 421, "unexpected Host header");

    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      const origin = req.headers.origin;
      if (origin !== undefined && !allowedOrigins().has(origin)) return text(res, 403, "cross-origin request");
    }

    const queryToken = url.searchParams.get("token");
    if (queryToken !== null && method === "GET" && !url.pathname.startsWith("/api/")) {
      if (!sameToken(queryToken, opts.token)) return text(res, 401, "bad token");
      res.writeHead(302, {
        location: "/",
        "set-cookie": `${cookieName(port)}=${opts.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
      });
      res.end();
      return;
    }

    if (!sameToken(cookieToken(req, port), opts.token)) {
      return text(res, 401, "excaliagent: open the URL printed in the terminal (it carries the access token).");
    }

    if (url.pathname.startsWith("/api/")) return api(req, res, url.pathname, url.searchParams);
    if (opts.middleware) return opts.middleware(req, res, () => text(res, 404, "not found"));
    return serveStatic(req, res, url.pathname);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError || err instanceof StatusError ? err.status : 500;
      if (status === 500) console.error("excaliagent:", err);
      if (!res.headersSent) json(res, status, { error: (err as Error).message });
      else res.end();
    });
  });

  return {
    server,
    get port() {
      return port;
    },
    listen(p) {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(p, host, () => {
          server.off("error", reject);
          const addr = server.address();
          port = typeof addr === "object" && addr ? addr.port : p;
          resolve();
        });
      });
    },
    close() {
      return new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
