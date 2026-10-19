import { describe, expect, it } from "vitest";
import {
  CARD_H,
  CARD_W,
  DETAIL_LINES,
  PAD,
  TITLE_GAP,
  TITLE_SIZE,
  detailsText,
  formatAge,
  makeCard,
  makeInbox,
  statusStyle,
  titleText,
  estimateMeasure,
  INNER_W,
  type Measure,
  DETAIL_SIZE,
  DETAIL_LH,
  TITLE_LH,
} from "./cards.ts";
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

/** Monospace test measurer: 10px per char regardless of font → 27 chars per 272px line. */
const mono: Measure = (t) => t.length * 10;

describe("titleText", () => {
  it("title, then name, then repo", () => {
    expect(titleText(session())).toBe("ExcaliClaude handoff");
    expect(titleText(session({ title: undefined }))).toBe("excaliagent-64");
    expect(titleText(session({ title: "", name: undefined }))).toBe("excaliagent");
  });

  it("fits on one line when short enough", () => {
    expect(titleText(session({ title: "Fix flaky checkout test" }), mono)).toBe("Fix flaky checkout test");
  });

  it("word-wraps to a second line", () => {
    expect(titleText(session({ title: "Node.js first slices setup on NixOS" }), mono)).toBe(
      "Node.js first slices setup\non NixOS",
    );
  });

  it("truncates only the second line with … when still too long", () => {
    const t = titleText(session({ title: "one two three four five six seven eight nine ten eleven twelve thirteen" }), mono);
    const [l1, l2, l3] = t.split("\n");
    expect(l3).toBeUndefined();
    expect(l1).toBe("one two three four five six");
    expect(l2!.endsWith("…")).toBe(true);
    expect(mono(l2!, 5, 20)).toBeLessThanOrEqual(INNER_W);
    expect(l2!.startsWith("seven eight")).toBe(true);
  });

  it("breaks a long single word by characters", () => {
    expect(titleText(session({ title: "x".repeat(40) }), mono)).toBe(`${"x".repeat(27)}\n${"x".repeat(13)}`);
    expect(titleText(session({ title: `ab ${"y".repeat(30)}` }), mono)).toBe(`ab\n${"y".repeat(26)}…`);
  });

  it("collapses whitespace and newlines", () => {
    expect(titleText(session({ title: "a\n  b" }))).toBe("a b");
  });

  it("the default measurer is used when none is given and keeps lines within the width", () => {
    const t = titleText(session({ title: "A very long title ".repeat(10) }));
    expect(t.split("\n")).toHaveLength(2);
    for (const l of t.split("\n")) expect(estimateMeasure(l, 5, TITLE_SIZE)).toBeLessThanOrEqual(INNER_W);
  });
});

describe("measurer injection", () => {
  it("makeCard measures title and details with their font and size, and sizes boxes from it", () => {
    const calls: Array<[number, number]> = [];
    const m: Measure = (t, f, z) => (calls.push([f, z]), t.length * 5);
    const [, title, details] = makeCard(session(), { x: 0, y: 0 }, testGen(), NOW, m);
    expect(calls).toContainEqual([5, 20]);
    expect(calls).toContainEqual([6, 14]);
    expect(title.width).toBe("ExcaliClaude handoff".length * 5);
    expect(details.width).toBe(Math.max(...details.text.split("\n").map((l) => l.length * 5)));
  });

  it("details are truncated by measured width", () => {
    const wide: Measure = (t) => t.length * 20; // 13 chars per line
    const lines = detailsText(session(), NOW, wide).split("\n");
    for (const l of lines) expect(wide(l, 6, 14)).toBeLessThanOrEqual(INNER_W);
    expect(lines[0]).toBe("excaliagent…");
  });
});

describe("detailsText", () => {
  const lines = (over: Parameters<typeof session>[0]) => detailsText(session(over), NOW).split("\n");

  it("renders all five lines", () => {
    const s = session({
      status: "waiting",
      waitingFor: "input needed",
      pane: { paneId: "w7:p1", workspaceId: "w7", workspaceLabel: "excaliagent", tabLabel: "claude" },
      prLinks: ["https://github.com/a/b/pull/3", "https://github.com/me/excaliagent/pull/12"],
    });
    expect(detailsText(s, NOW).split("\n")).toEqual([
      "excaliagent · main",
      "waiting: input needed · 2m",
      "cache warm 41m",
      "herdr: excaliagent › claude",
      "PR #12",
    ]);
  });

  it("status without waitingFor, underscores as spaces", () => {
    expect(lines({ status: "needs_user" })[1]).toBe("needs user · 2m");
  });

  it("herdr label fallbacks", () => {
    expect(lines({ pane: { paneId: "w7:p1", workspaceId: "w7", tabLabel: "claude" } })[3]).toBe("herdr: claude");
    expect(lines({ pane: { paneId: "w7:p1", workspaceId: "w7", workspaceLabel: "ws" } })[3]).toBe("herdr: ws");
    expect(lines({ pane: { paneId: "w7:p1", workspaceId: "w7" } })[3]).toBe("herdr: w7:p1");
  });

  it("live without pane says not in herdr", () => {
    expect(lines({ pane: undefined })[3]).toBe("not in herdr");
  });

  it("cache cold, and omitted when unknown", () => {
    expect(lines({ cacheExpiresAt: NOW - MIN })[2]).toBe("cache cold");
    expect(lines({ cacheExpiresAt: 0 })).toEqual(["excaliagent · main", "busy · 2m", "herdr: w7:p1"]);
  });

  it("dormant: no herdr line, cache still shown", () => {
    expect(lines({ live: false, status: "dormant", cacheExpiresAt: NOW - DAY, lastActivityAt: NOW - 3 * DAY })).toEqual([
      "excaliagent · main",
      "dormant · 3d",
      "cache cold",
    ]);
  });

  it("no branch shows only the repo", () => {
    expect(lines({ branch: undefined })[0]).toBe("excaliagent");
  });

  it("non-github PR links lose the scheme and are truncated", () => {
    expect(lines({ prLinks: ["https://gitlab.example.com/x/-/mr/4"] })[4]).toBe("gitlab.example.com/x/-/mr/4");
    const long = lines({ prLinks: ["https://gitlab.example.com/group/project/-/merge_requests/4"] })[4]!;
    expect(long.endsWith("…")).toBe(true);
    expect(estimateMeasure(long, 6, DETAIL_SIZE)).toBeLessThanOrEqual(INNER_W);
  });
});

describe("makeCard", () => {
  it("builds rect + title + details sharing one fresh group", () => {
    const s = session({ prLinks: ["https://github.com/a/b/pull/1"] });
    const [rect, title, details] = makeCard(s, { x: 60, y: 100 }, testGen(), NOW);
    expect(rect).toMatchObject({
      type: "rectangle",
      x: 60,
      y: 100,
      width: CARD_W,
      height: CARD_H,
      backgroundColor: "#a5d8ff",
      strokeColor: "#1971c2",
      fillStyle: "solid",
      roundness: { type: 3 },
      index: null,
      boundElements: null,
      customData: { excaliagent: { kind: "card", source: "claude", sessionId: "s1" } },
    });
    expect(rect.groupIds).toHaveLength(1);
    expect(title.groupIds).toEqual(rect.groupIds);
    expect(details.groupIds).toEqual(rect.groupIds);
    expect(title).toMatchObject({
      type: "text",
      containerId: null,
      text: titleText(s),
      originalText: titleText(s),
      fontSize: 20,
      fontFamily: 5,
      strokeColor: "#1e1e1e",
      x: 60 + PAD,
      y: 100 + PAD,
      autoResize: true,
      customData: { excaliagent: { kind: "card-title", sessionId: "s1", cardId: rect.id } },
    });
    expect(details).toMatchObject({
      type: "text",
      containerId: null,
      text: detailsText(s, NOW),
      fontSize: 14,
      fontFamily: 6,
      strokeColor: "#495057",
      x: 60 + PAD,
      y: title.y + title.height + TITLE_GAP,
      customData: { excaliagent: { kind: "card-details", sessionId: "s1", cardId: rect.id } },
    });
    expect(details.height).toBeCloseTo(5 * 14 * 1.35);
    expect(rect.y + PAD + 2 * TITLE_SIZE * TITLE_LH + TITLE_GAP + DETAIL_LINES * DETAIL_SIZE * DETAIL_LH + PAD).toBeLessThanOrEqual(rect.y + rect.height);
  });
});

describe("makeInbox", () => {
  it("creates an inbox rectangle and a title text above it", () => {
    const els = makeInbox(testGen(), NOW);
    const rect = els.find((e) => e.type === "rectangle")!;
    expect(rect.customData).toEqual({ excaliagent: { kind: "inbox" } });
    const label = els.find((e) => e.type === "text");
    expect(label).toMatchObject({ text: "inbox", containerId: null });
    expect(label!.y + label!.height).toBeLessThanOrEqual(rect.y);
  });
});
