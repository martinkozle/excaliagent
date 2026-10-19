import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitReader, readGitInfo } from "./git.ts";

const SHA = "3f2a9c1d0b4e5f60718293a4b5c6d7e8f9012345";
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "excaliagent-git-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

async function repo(path: string, head: string) {
  await mkdir(join(path, ".git"), { recursive: true });
  await writeFile(join(path, ".git", "HEAD"), head);
}

describe("readGitInfo", () => {
  it("reads the branch of a normal repo", async () => {
    const r = join(dir, "demo-app");
    await repo(r, "ref: refs/heads/feat/mvp-slices\n");
    expect(await readGitInfo(r)).toEqual({ root: r, branch: "feat/mvp-slices" });
  });

  it("walks up from a subdirectory and reports the repo root", async () => {
    const r = join(dir, "demo-app");
    await repo(r, "ref: refs/heads/main\n");
    const sub = join(r, "packages", "web", "src");
    await mkdir(sub, { recursive: true });
    expect(await readGitInfo(sub)).toEqual({ root: r, branch: "main" });
  });

  it("shortens a detached HEAD sha", async () => {
    const r = join(dir, "demo-app");
    await repo(r, SHA + "\n");
    expect((await readGitInfo(r))!.branch).toBe("3f2a9c1");
  });

  it("follows a relative gitdir file (worktree)", async () => {
    const main = join(dir, "demo-app");
    await repo(main, "ref: refs/heads/main\n");
    const wtGit = join(main, ".git", "worktrees", "wt1");
    await mkdir(wtGit, { recursive: true });
    await writeFile(join(wtGit, "HEAD"), "ref: refs/heads/feature/cards\n");
    const wt = join(dir, "demo-app-wt1");
    await mkdir(join(wt, "src"), { recursive: true });
    await writeFile(join(wt, ".git"), "gitdir: ../demo-app/.git/worktrees/wt1\n");
    expect(await readGitInfo(join(wt, "src"))).toEqual({ root: wt, branch: "feature/cards" });
  });

  it("follows an absolute gitdir file (submodule)", async () => {
    const modGit = join(dir, "super", ".git", "modules", "lib");
    await mkdir(modGit, { recursive: true });
    await writeFile(join(modGit, "HEAD"), SHA);
    const lib = join(dir, "super", "lib");
    await mkdir(lib, { recursive: true });
    await writeFile(join(lib, ".git"), `gitdir: ${modGit}\n`);
    expect(await readGitInfo(lib)).toEqual({ root: lib, branch: "3f2a9c1" });
  });

  it("returns undefined outside a repo, for a missing cwd, or for an unreadable HEAD", async () => {
    // tmpdir itself is not expected to be inside a repo
    expect(await readGitInfo(join(dir, "nowhere", "deep"))).toBeUndefined();
    expect(await readGitInfo("")).toBeUndefined();
    const broken = join(dir, "broken");
    await mkdir(join(broken, ".git"), { recursive: true });
    expect(await readGitInfo(broken)).toBeUndefined();
    await writeFile(join(broken, ".git", "HEAD"), "garbage\n");
    expect(await readGitInfo(broken)).toBeUndefined();
  });
});

describe("GitReader cache", () => {
  it("re-reads at most every ttlMs", async () => {
    const r = join(dir, "demo-app");
    await repo(r, "ref: refs/heads/main\n");
    let now = 1000;
    const reader = new GitReader({ ttlMs: 2000, now: () => now });
    expect((await reader.get(r))!.branch).toBe("main");
    await writeFile(join(r, ".git", "HEAD"), "ref: refs/heads/next\n");
    await utimes(join(r, ".git", "HEAD"), 5, 5); // force a distinct mtime
    now += 500;
    // within TTL: cached value even though HEAD changed
    expect((await reader.get(r))!.branch).toBe("main");
    now += 2000;
    expect((await reader.get(r))!.branch).toBe("next");
  });
});
