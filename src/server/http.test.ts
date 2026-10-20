import { request as httpRequest } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../shared/types.ts";
import type { Hub } from "./hub.ts";
import { createAppServer, type AppServer } from "./http.ts";
import { createSceneStore } from "./scene-store.ts";

const TOKEN = "t0ken-abc";
const RESUMABLE = "0b6f3c1e-1111-4a2b-9c3d-123456789abc";
const LIVE = "11111111-2222-3333-4444-555555555555";
const NO_HERDR = "22222222-2222-3333-4444-555555555555";
const webRoot = join(import.meta.dirname, "__fixtures__", "web");

function session(over: Partial<Session> = {}): Session {
  return {
    id: "s1", source: "claude", cwd: "/r/app", repo: "app", status: "busy", lastActivityAt: 1,
    cacheTtlMs: 0, cacheExpiresAt: 0, live: true, pid: 100, prLinks: [], ...over,
  };
}

function fakeHub() {
  let current = [session()];
  const listeners = new Set<(s: Session[]) => void>();
  const hub: Hub & { emit(s: Session[]): void } = {
    start: async () => {},
    stop: () => {},
    sessions: () => current,
    subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    lookup: async (ids) => [...current, session({ id: "d1", live: false, status: "dormant" })].filter((s) => ids.includes(s.id)),
    picker: async () => [session({ id: "d1", live: false, status: "dormant" })],
    focus: vi.fn(async (id: string) => id === "s1"),
    end: vi.fn(async (id: string) => (id === RESUMABLE ? ("not-live" as const) : id === LIVE ? ("ended" as const) : ("unknown" as const))),
    resume: vi.fn(async (id: string) =>
      id === RESUMABLE ? ("resumed" as const) : id === LIVE ? ("live" as const) : id === NO_HERDR ? ("no-herdr" as const) : ("unknown" as const),
    ),
    emit(s) { current = s; for (const l of listeners) l(s); },
  };
  return hub;
}

let dir: string;
let server: AppServer;
let hub: ReturnType<typeof fakeHub>;
let base: string;
let cookie: string;

/** Raw request so we can forge the Host header (fetch forbids it). */
function raw(path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port: server.port, path, headers }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "excaliagent-http-"));
  hub = fakeHub();
  server = createAppServer({ hub, scenes: createSceneStore(dir), token: TOKEN, webRoot });
  await server.listen(0);
  base = `http://127.0.0.1:${server.port}`;
  cookie = `excaliagent_token_${server.port}=${TOKEN}`;
});
afterEach(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

describe("auth", () => {
  it("exchanges the URL token for an HttpOnly cookie and redirects to a clean URL", async () => {
    const res = await fetch(`${base}/?token=${TOKEN}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const setCookie = res.headers.get("set-cookie") ?? "";
    // Named per port: browsers share cookies across ports, and two boards must not clobber each other.
    expect(setCookie).toContain(`excaliagent_token_${server.port}=${TOKEN}`);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Max-Age=31536000/); // the token is stable, so the cookie outlives a restart
  });

  it("refuses a wrong token", async () => {
    const res = await fetch(`${base}/?token=nope`, { redirect: "manual" });
    expect(res.status).toBe(401);
  });

  it("refuses the page and the API without a cookie", async () => {
    expect((await fetch(`${base}/`)).status).toBe(401);
    expect((await fetch(`${base}/api/sessions`)).status).toBe(401);
    expect((await fetch(`${base}/api/sessions`, { headers: { cookie: `excaliagent_token_${server.port}=bad` } })).status).toBe(401);
    // Another port's cookie does not count.
    expect((await fetch(`${base}/api/sessions`, { headers: { cookie: `excaliagent_token_1=${TOKEN}` } })).status).toBe(401);
  });

  it("serves the page and assets with the cookie", async () => {
    const page = await fetch(`${base}/`, { headers: { cookie } });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(await page.text()).toContain("hello");
    const js = await fetch(`${base}/assets/app.js`, { headers: { cookie } });
    expect(js.headers.get("content-type")).toMatch(/javascript/);
  });

  it("does not escape the web root", async () => {
    const res = await raw("/assets/../../http.test.ts", { cookie, host: `127.0.0.1:${server.port}` });
    expect(res.status).toBe(404);
    const enc = await raw("/%2e%2e/%2e%2e/http.test.ts", { cookie, host: `127.0.0.1:${server.port}` });
    expect(enc.status).toBe(404);
  });

  it("rejects foreign Host headers (DNS rebinding)", async () => {
    const res = await raw("/api/sessions", { cookie, host: `evil.example:${server.port}` });
    expect(res.status).toBe(421);
    const ok = await raw("/api/sessions", { cookie, host: `localhost:${server.port}` });
    expect(ok.status).toBe(200);
  });

  it("rejects cross-origin writes even with the cookie", async () => {
    const res = await fetch(`${base}/api/focus`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ sessionId: "s1" }),
    });
    expect(res.status).toBe(403);
    expect(hub.focus).not.toHaveBeenCalled();
  });
});

describe("api", () => {
  const get = (path: string) => fetch(`${base}${path}`, { headers: { cookie } });
  const send = (method: string, path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { cookie, "content-type": "application/json", origin: base },
      body: JSON.stringify(body),
    });

  it("GET /api/sessions returns live sessions", async () => {
    expect((await (await get("/api/sessions")).json()).map((s: Session) => s.id)).toEqual(["s1"]);
  });

  it("GET /api/picker returns dormant sessions", async () => {
    expect((await (await get("/api/picker")).json()).map((s: Session) => s.id)).toEqual(["d1"]);
  });

  it("POST /api/lookup returns known sessions by id", async () => {
    const res = await send("POST", "/api/lookup", { ids: ["s1", "d1", "zz"] });
    expect((await res.json()).map((s: Session) => s.id)).toEqual(["s1", "d1"]);
    expect((await send("POST", "/api/lookup", { ids: "nope" })).status).toBe(400);
  });

  it("scene round-trips through GET/PUT", async () => {
    expect(await (await get("/api/scene")).json()).toEqual({ elements: [], appState: {} });
    const scene = { elements: [{ id: "r1", type: "rectangle" }], appState: { viewBackgroundColor: "#fff" } };
    expect((await send("PUT", "/api/scene", scene)).status).toBe(204);
    expect(await (await get("/api/scene")).json()).toEqual(scene);
  });

  it("image files round-trip through PUT /api/files and POST /api/files/get", async () => {
    const file = { id: "f00d", mimeType: "image/png", dataURL: "data:image/png;base64,AAAA", created: 1 };
    expect((await send("PUT", "/api/files", { files: [file] })).status).toBe(204);
    const res = await send("POST", "/api/files/get", { ids: ["f00d", "nope"] });
    expect(await res.json()).toEqual([file]);
    expect((await send("PUT", "/api/files", { files: [{ ...file, id: "../x" }] })).status).toBe(400);
    expect((await send("PUT", "/api/files", { files: "x" })).status).toBe(400);
    expect((await send("POST", "/api/files/get", { ids: [1] })).status).toBe(400);
    const foreign = await fetch(`${base}/api/files`, {
      method: "PUT",
      headers: { cookie, "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ files: [{ ...file, id: "evil" }] }),
    });
    expect(foreign.status).toBe(403);
  });

  it("PUT /api/scene rejects garbage", async () => {
    expect((await send("PUT", "/api/scene", { elements: "x" })).status).toBe(400);
    const bad = await fetch(`${base}/api/scene`, {
      method: "PUT", headers: { cookie, "content-type": "application/json" }, body: "{oops",
    });
    expect(bad.status).toBe(400);
  });

  it("POST /api/resume: 204 resumed, 409 live / no herdr, 404 unknown, 400 bad id", async () => {
    const res = await send("POST", "/api/resume", { sessionId: RESUMABLE });
    expect(res.status).toBe(204);
    expect(hub.resume).toHaveBeenCalledWith(RESUMABLE);
    const live = await send("POST", "/api/resume", { sessionId: LIVE });
    expect([live.status, await live.json()]).toEqual([409, { error: "live" }]);
    const off = await send("POST", "/api/resume", { sessionId: NO_HERDR });
    expect([off.status, await off.json()]).toEqual([409, { error: "no herdr" }]);
    const unknown = await send("POST", "/api/resume", { sessionId: "99999999-2222-3333-4444-555555555555" });
    expect(unknown.status).toBe(404);
    hub.resume.mockClear();
    for (const body of [{}, { sessionId: 5 }, { sessionId: "../x" }, { sessionId: `${RESUMABLE} && echo` }]) {
      expect((await send("POST", "/api/resume", body)).status).toBe(400);
    }
    expect(hub.resume).not.toHaveBeenCalled();
  });

  it("POST /api/resume refuses cross-origin and cookieless requests", async () => {
    const cross = await fetch(`${base}/api/resume`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ sessionId: RESUMABLE }),
    });
    expect(cross.status).toBe(403);
    const anon = await fetch(`${base}/api/resume`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: base },
      body: JSON.stringify({ sessionId: RESUMABLE }),
    });
    expect(anon.status).toBe(401);
    expect(hub.resume).not.toHaveBeenCalled();
  });

  it("POST /api/end: 204 ended, 409 not running, 400 bad id; refuses cross-origin", async () => {
    expect((await send("POST", "/api/end", { sessionId: LIVE })).status).toBe(204);
    expect(hub.end).toHaveBeenCalledWith(LIVE);
    expect((await send("POST", "/api/end", { sessionId: RESUMABLE })).status).toBe(409);
    expect((await send("POST", "/api/end", { sessionId: "x; kill -9 1" })).status).toBe(400);
    const foreign = await fetch(`${base}/api/end`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: "http://evil.example" },
      body: JSON.stringify({ sessionId: LIVE }),
    });
    expect(foreign.status).toBe(403);
    expect(hub.end).toHaveBeenCalledTimes(2);
  });

  it("POST /api/focus focuses a session with a pane and 409s otherwise", async () => {
    expect((await send("POST", "/api/focus", { sessionId: "s1" })).status).toBe(204);
    expect(hub.focus).toHaveBeenCalledWith("s1");
    expect((await send("POST", "/api/focus", { sessionId: "other" })).status).toBe(409);
    expect((await send("POST", "/api/focus", {})).status).toBe(400);
  });

  it("unknown API routes 404", async () => {
    expect((await get("/api/nope")).status).toBe(404);
  });

  it("GET /api/events streams the current list, then every change", async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/events`, { headers: { cookie }, signal: ctrl.signal });
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    const nextEvent = async (): Promise<Session[]> => {
      for (;;) {
        const idx = buf.indexOf("\n\n");
        if (idx >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const data = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (data) return JSON.parse(data.slice(6));
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("stream ended");
        buf += decoder.decode(value, { stream: true });
      }
    };
    expect((await nextEvent()).map((s) => s.id)).toEqual(["s1"]);
    hub.emit([session(), session({ id: "s2" })]);
    expect((await nextEvent()).map((s) => s.id)).toEqual(["s1", "s2"]);
    ctrl.abort();
  });
});
