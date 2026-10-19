import { describe, expect, it } from "vitest";
import { dormantSession } from "./claude.ts";
import type { TranscriptInfo } from "./transcript.ts";

const file = { id: "0a1b2c3d-0000-4000-8000-000000000009", slug: "-home-alice-src-demo-app", path: "/x.jsonl", mtimeMs: 1 };
const info = (gitBranch?: string): TranscriptInfo => ({
  cwd: "/home/alice/src/demo-app",
  gitBranch,
  prLinks: [],
  lastTimestamp: 1,
  lastAssistantAt: 1,
  cacheTtlMs: 0,
  cacheExpiresAt: 0,
});
const git = { root: "/home/alice/src/demo-app", branch: "main" };

describe("dormant session branch", () => {
  it("keeps the branch the session was on", () => {
    expect(dormantSession(file as never, info("feat/oauth"), undefined, git).branch).toBe("feat/oauth");
  });
  it("replaces the stale HEAD stamp with the repo's branch", () => {
    expect(dormantSession(file as never, info("HEAD"), undefined, git).branch).toBe("main");
  });
  it("uses the repo's branch when the transcript has none", () => {
    expect(dormantSession(file as never, info(undefined), undefined, git).branch).toBe("main");
  });
});
