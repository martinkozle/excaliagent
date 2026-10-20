import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearRunning, findRunning, recordRunning } from "./instance.ts";

const TOKEN = "t".repeat(32);
let dir: string;
let servers: Server[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "excaliagent-instance-"));
});
afterEach(async () => {
  for (const s of servers) s.close();
  servers = [];
  await rm(dir, { recursive: true, force: true });
});

/** A stand-in board: 200 on /api/sessions only with its own token cookie. */
async function fakeBoard(token: string): Promise<number> {
  const s = createServer((req, res) => {
    const port = (s.address() as { port: number }).port;
    const ok = req.url === "/api/sessions" && req.headers.cookie === `excaliagent_token_${port}=${token}`;
    res.writeHead(ok ? 200 : 401).end(ok ? "[]" : "");
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as { port: number }).port;
}

describe("running instance per state dir", () => {
  it("finds a board started for this state dir that answers to our token", async () => {
    const port = await fakeBoard(TOKEN);
    await recordRunning(dir, port, process.pid);
    expect(await findRunning(dir, TOKEN)).toBe(port);
  });

  it("ignores no record, a dead pid, a board with another token, and a closed port", async () => {
    expect(await findRunning(dir, TOKEN)).toBeUndefined();
    const port = await fakeBoard(TOKEN);
    await recordRunning(dir, port, 2 ** 22 + 12345); // no such pid
    expect(await findRunning(dir, TOKEN)).toBeUndefined();
    const other = await fakeBoard("o".repeat(32));
    await recordRunning(dir, other, process.pid);
    expect(await findRunning(dir, TOKEN)).toBeUndefined();
    await recordRunning(dir, 1, process.pid); // nothing listens on port 1
    expect(await findRunning(dir, TOKEN)).toBeUndefined();
    await writeFile(join(dir, "server.json"), "{garbage");
    expect(await findRunning(dir, TOKEN)).toBeUndefined();
  });

  it("clears only its own record", async () => {
    await recordRunning(dir, 4000, 111);
    await clearRunning(dir, 222);
    expect(JSON.parse(await readFile(join(dir, "server.json"), "utf8"))).toEqual({ port: 4000, pid: 111 });
    await clearRunning(dir, 111);
    await expect(readFile(join(dir, "server.json"), "utf8")).rejects.toThrow();
  });
});
