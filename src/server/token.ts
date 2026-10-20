// The access token: created once per state dir and reused, so the browser's
// cookie (and a bookmark of the board) survives restarts. The file is 0600;
// whatever can read it could read ~/.claude too.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const VALID = /^[A-Za-z0-9_-]{32,}$/;

export async function loadOrCreateToken(stateDir: string): Promise<string> {
  const path = join(stateDir, "token");
  try {
    const t = (await readFile(path, "utf8")).trim();
    if (VALID.test(t)) return t;
  } catch {
    // missing: create it
  }
  await mkdir(stateDir, { recursive: true });
  const token = randomBytes(24).toString("base64url");
  await writeFile(path, `${token}\n`, { mode: 0o600 });
  await chmod(path, 0o600); // mode only applies when the file is created
  return token;
}
