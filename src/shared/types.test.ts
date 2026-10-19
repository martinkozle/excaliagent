import { describe, expect, it } from "vitest";
import { NEEDS_INPUT } from "./types.ts";

describe("NEEDS_INPUT", () => {
  it("contains exactly the loud statuses", () => {
    expect([...NEEDS_INPUT].sort()).toEqual(["blocked", "needs_trust", "needs_user", "waiting"]);
  });
});
