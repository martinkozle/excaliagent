import { describe, expect, it } from "vitest";
import { CARD_H, CARD_W, formatAge, labelText, makeCard, makeInbox, statusStyle } from "./cards.ts";
import { DAY, HOUR, MIN, NOW, session, testGen } from "./__fixtures__/helpers.ts";

describe("statusStyle", () => {
  const cases: Array<[string, Parameters<typeof statusStyle>[0], string, string, string]> = [
    ["needs_user", session({ status: "needs_user" }), "#ffc9c9", "#e03131", "solid"],
    ["waiting", session({ status: "waiting" }), "#ffc9c9", "#e03131", "solid"],
    ["needs_trust", session({ status: "needs_trust" }), "#ffc9c9", "#e03131", "solid"],
    ["blocked", session({ status: "blocked" }), "#ffc9c9", "#e03131", "solid"],
    ["busy", session({ status: "busy" }), "#a5d8ff", "#1971c2", "solid"],
    ["idle warm", session({ status: "idle" }), "#b2f2bb", "#2f9e44", "solid"],
    ["idle cold", session({ status: "idle", cacheExpiresAt: NOW - 1 }), "#e9ecef", "#868e96", "solid"],
    ["idle unknown cache", session({ status: "idle", cacheExpiresAt: 0 }), "#e9ecef", "#868e96", "solid"],
    ["exited", session({ status: "exited" }), "#f8f9fa", "#adb5bd", "dashed"],
    ["dormant", session({ status: "dormant", live: false }), "#f8f9fa", "#adb5bd", "dashed"],
    ["not live", session({ status: "busy", live: false }), "#f8f9fa", "#adb5bd", "dashed"],
    ["missing", undefined, "#f8f9fa", "#adb5bd", "dashed"],
  ];
  it.each(cases)("%s", (_name, s, bg, stroke, style) => {
    expect(statusStyle(s, NOW)).toEqual({ backgroundColor: bg, strokeColor: stroke, strokeStyle: style, fillStyle: "solid" });
  });
});

describe("formatAge", () => {
  it.each([
    [0, "now"],
    [59_000, "now"],
    [2 * MIN, "2m"],
    [59 * MIN, "59m"],
    [3 * HOUR + 5 * MIN, "3h"],
    [4 * DAY + HOUR, "4d"],
    [-5 * MIN, "now"],
  ])("%d ms → %s", (ms, out) => expect(formatAge(ms)).toBe(out));
});

describe("labelText", () => {
  it("renders the full five-line label", () => {
    const s = session({
      status: "waiting",
      waitingFor: "input needed",
      prLinks: ["https://github.com/a/b/pull/3", "https://github.com/me/excaliagent/pull/12"],
    });
    expect(labelText(s, NOW)).toBe(
      ["ExcaliClaude handoff", "excaliagent · main", "waiting: input needed · 2m", "cache warm 41m · herdr w7:p1", "PR #12"].join("\n"),
    );
  });

  it("status without waitingFor, underscores as spaces", () => {
    expect(labelText(session({ status: "needs_user" }), NOW).split("\n")[2]).toBe("needs user · 2m");
  });

  it("live without pane says no pane", () => {
    expect(labelText(session({ pane: undefined }), NOW).split("\n")[3]).toBe("cache warm 41m · no pane");
  });

  it("cache cold", () => {
    expect(labelText(session({ cacheExpiresAt: NOW - MIN }), NOW).split("\n")[3]).toBe("cache cold · herdr w7:p1");
  });

  it("unknown cache omits the cache part", () => {
    expect(labelText(session({ cacheExpiresAt: 0 }), NOW).split("\n")[3]).toBe("herdr w7:p1");
  });

  it("unknown cache and no pane info for a dormant session drops the line", () => {
    const s = session({ live: false, status: "dormant", cacheExpiresAt: 0, pane: undefined, lastActivityAt: NOW - 3 * DAY });
    expect(labelText(s, NOW)).toBe(["ExcaliClaude handoff", "excaliagent · main", "dormant · 3d"].join("\n"));
  });

  it("dormant shows cache but never pane", () => {
    const s = session({ live: false, status: "dormant", cacheExpiresAt: NOW - DAY, lastActivityAt: NOW - 3 * DAY });
    expect(labelText(s, NOW).split("\n").slice(2)).toEqual(["dormant · 3d", "cache cold"]);
  });

  it("title falls back to name, then repo", () => {
    expect(labelText(session({ title: undefined }), NOW).split("\n")[0]).toBe("excaliagent-64");
    expect(labelText(session({ title: "", name: undefined }), NOW).split("\n")[0]).toBe("excaliagent");
  });

  it("no branch shows only the repo", () => {
    expect(labelText(session({ branch: undefined }), NOW).split("\n")[1]).toBe("excaliagent");
  });

  it("non-github PR links are shown without scheme", () => {
    const s = session({ prLinks: ["https://gitlab.example.com/x/-/mr/4"] });
    expect(labelText(s, NOW).split("\n")[4]).toBe("gitlab.example.com/x/-/mr/4");
  });

  it("long non-github PR links are truncated", () => {
    const s = session({ prLinks: ["https://gitlab.example.com/group/project/-/merge_requests/4"] });
    const line = labelText(s, NOW).split("\n")[4]!;
    expect(line.startsWith("gitlab.example.com/group/")).toBe(true);
    expect(line.endsWith("…")).toBe(true);
  });

  it("truncates very long lines so they do not wrap", () => {
    const line0 = labelText(session({ title: "x".repeat(200) }), NOW).split("\n")[0]!;
    expect(line0.length).toBeLessThanOrEqual(40);
    expect(line0.endsWith("…")).toBe(true);
  });
});

describe("makeCard", () => {
  it("builds a rectangle and its bound label", () => {
    const s = session({ prLinks: ["https://github.com/a/b/pull/1"] });
    const [rect, text] = makeCard(s, { x: 60, y: 100 }, testGen(), NOW);
    expect(rect).toMatchObject({
      type: "rectangle",
      x: 60,
      y: 100,
      width: CARD_W,
      height: CARD_H,
      backgroundColor: "#a5d8ff",
      strokeColor: "#1971c2",
      strokeStyle: "solid",
      fillStyle: "solid",
      roundness: { type: 3 },
      isDeleted: false,
      index: null,
      updated: NOW,
      customData: { excaliagent: { kind: "card", source: "claude", sessionId: "s1" } },
      boundElements: [{ type: "text", id: text.id }],
    });
    expect(text).toMatchObject({
      type: "text",
      containerId: rect.id,
      text: labelText(s, NOW),
      originalText: labelText(s, NOW),
      fontSize: 14,
      x: 65,
      y: 105,
      textAlign: "left",
      verticalAlign: "top",
    });
    expect(text.height).toBeCloseTo(5 * 14 * text.lineHeight);
    expect(rect.id).not.toBe(text.id);
  });
});

describe("makeInbox", () => {
  it("creates an inbox rectangle and a title text", () => {
    const els = makeInbox(testGen(), NOW);
    const rect = els.find((e) => e.type === "rectangle")!;
    expect(rect.customData).toEqual({ excaliagent: { kind: "inbox" } });
    expect(rect.width).toBe(920);
    expect(rect.height).toBe(560);
    const label = els.find((e) => e.type === "text");
    expect(label).toMatchObject({ text: "inbox", containerId: null });
    expect(label!.y + label!.height).toBeLessThanOrEqual(rect.y);
  });
});
