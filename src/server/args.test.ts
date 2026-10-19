import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./args.ts";

describe("parseCliArgs", () => {
  it("has sane defaults", () => {
    expect(parseCliArgs([])).toEqual({
      port: 0, open: true, dev: false, herdr: true, stateDir: undefined, claudeDir: undefined, help: false, version: false,
    });
  });
  it("parses every flag", () => {
    expect(
      parseCliArgs(["--port", "4123", "--no-open", "--dev", "--no-herdr", "--state-dir", "/s", "--claude-dir", "/c"]),
    ).toMatchObject({ port: 4123, open: false, dev: true, herdr: false, stateDir: "/s", claudeDir: "/c" });
  });
  it("rejects a bad port", () => {
    expect(() => parseCliArgs(["--port", "abc"])).toThrow(/port/);
    expect(() => parseCliArgs(["--port", "70000"])).toThrow(/port/);
  });
  it("rejects unknown flags", () => {
    expect(() => parseCliArgs(["--frobnicate"])).toThrow();
  });
  it("supports --help and --version", () => {
    expect(parseCliArgs(["-h"]).help).toBe(true);
    expect(parseCliArgs(["--version"]).version).toBe(true);
  });
});
