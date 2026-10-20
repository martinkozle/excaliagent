import { describe, expect, it } from "vitest";
import { parseCliArgs } from "./args.ts";

describe("parseCliArgs", () => {
  it("has sane defaults", () => {
    expect(parseCliArgs([])).toEqual({
      port: undefined, open: true, dev: false, herdr: true, raise: true, stateDir: undefined, claudeDir: undefined, help: false, version: false,
    });
  });
  it("parses every flag", () => {
    expect(
      parseCliArgs(["--port", "4123", "--no-open", "--dev", "--no-herdr", "--state-dir", "/s", "--claude-dir", "/c"]),
    ).toMatchObject({ port: 4123, open: false, dev: true, herdr: false, stateDir: "/s", claudeDir: "/c" });
  });
  it("--no-raise keeps herdr focus but does not raise the terminal window", () => {
    expect(parseCliArgs(["--no-raise"])).toMatchObject({ herdr: true, raise: false });
  });
  it("--port 0 asks for a random free port", () => {
    expect(parseCliArgs(["--port", "0"]).port).toBe(0);
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
