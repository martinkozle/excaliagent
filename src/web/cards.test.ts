import { describe, expect, it } from "vitest";
import {
  CARD_H,
  CARD_W,
  cardHeight,
  DETAIL_LINES,
  PAD,
  TITLE_GAP,
  TITLE_SIZE,
  detailsText,
  formatAge,
  makeCard,
  makeInbox,
  statusStyle,
  shortPr,
  prLink,
  titleText,
  estimateMeasure,
  INNER_W,
  type Measure,
  DETAIL_SIZE,
  DETAIL_LH,
  TITLE_LH,
  TITLE_H,
  TITLE_W,
  LOGO_SIZE,
  makeCardLogo,
  makeCardCharacter,
  AVATAR_SIZE,
  TITLE_X,
  TEXT_W,
} from "./cards.ts";
import { DAY, HOUR, MIN, NOW, session, testGen } from "./__fixtures__/helpers.ts";
import { LOGOS } from "./logos.ts";

describe("statusStyle", () => {
  const cases: Array<[string, Parameters<typeof statusStyle>[0], string, string, string]> = [
    ["needs_user", session({ status: "needs_user" }), "#ffc9c9", "#e03131", "solid"],
    ["waiting", session({ status: "waiting" }), "#ffc9c9", "#e03131", "solid"],
    ["needs_trust", session({ status: "needs_trust" }), "#ffc9c9", "#e03131", "solid"],
    ["blocked", session({ status: "blocked" }), "#ffc9c9", "#e03131", "solid"],
    ["busy", session({ status: "busy" }), "#ffec99", "#f08c00", "solid"],
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

/** Monospace test measurer: 10px per char regardless of font → 20 title chars per 204px line, 27 details chars. */
const mono: Measure = (t) => t.length * 10;

describe("titleText", () => {
  it("title, then name, then repo", () => {
    expect(titleText(session()).replace("\n", " ")).toBe("ExcaliClaude handoff");
    expect(titleText(session({ title: undefined }))).toBe("excaliagent-64");
    expect(titleText(session({ title: "", name: undefined }))).toBe("excaliagent");
  });

  it("fits on one line when short enough", () => {
    expect(titleText(session({ title: "Fix flaky checkout" }), mono)).toBe("Fix flaky checkout");
  });

  it("word-wraps to a second line", () => {
    expect(titleText(session({ title: "Node.js first slices on NixOS" }), mono)).toBe(
      "Node.js first slices\non NixOS",
    );
  });

  it("truncates only the second line with … when still too long", () => {
    const t = titleText(session({ title: "one two three four five six seven eight nine ten eleven twelve thirteen" }), mono);
    const [l1, l2, l3] = t.split("\n");
    expect(l3).toBeUndefined();
    expect(l1).toBe("one two three four");
    expect(l2!.endsWith("…")).toBe(true);
    expect(mono(l2!, 5, 20)).toBeLessThanOrEqual(TITLE_W);
    expect(l2!.startsWith("five six")).toBe(true);
  });

  it("breaks a long single word by characters (20 chars fit between the character and the logo)", () => {
    expect(titleText(session({ title: "x".repeat(30) }), mono)).toBe(`${"x".repeat(20)}\n${"x".repeat(10)}`);
    expect(titleText(session({ title: "x".repeat(45) }), mono)).toBe(`${"x".repeat(20)}\n${"x".repeat(19)}…`);
    expect(titleText(session({ title: `ab ${"y".repeat(30)}` }), mono)).toBe(`ab\n${"y".repeat(19)}…`);
  });

  it("collapses whitespace and newlines", () => {
    expect(titleText(session({ title: "a\n  b" }))).toBe("a b");
  });

  it("the default measurer is used when none is given and keeps lines within the width", () => {
    const t = titleText(session({ title: "A very long title ".repeat(10) }));
    expect(t.split("\n")).toHaveLength(2);
    for (const l of t.split("\n")) expect(estimateMeasure(l, 5, TITLE_SIZE)).toBeLessThanOrEqual(TITLE_W);
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
    for (const l of lines) expect(wide(l, 6, 14)).toBeLessThanOrEqual(TEXT_W);
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
    expect(lines({ prLinks: ["https://example.com/x/y/4"] })[4]).toBe("example.com/x/y/4");
    const long = lines({ prLinks: ["https://code.example.com/group/project/some/long/path/4"] })[4]!;
    expect(long.endsWith("…")).toBe(true);
    expect(estimateMeasure(long, 6, DETAIL_SIZE)).toBeLessThanOrEqual(INNER_W);
  });
});

describe("makeCard", () => {
  it("builds rect + title + details sharing one fresh group", () => {
    const s = session({ title: "Handoff", prLinks: ["https://github.com/a/b/pull/1"] });
    const [rect, title, details] = makeCard(s, { x: 60, y: 100 }, testGen(), NOW);
    expect(rect).toMatchObject({
      type: "rectangle",
      x: 60,
      y: 100,
      width: CARD_W,
      height: cardHeight(1),
      backgroundColor: "#ffec99",
      strokeColor: "#f08c00",
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
      x: 60 + TITLE_X,
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
    // A one-line title: the card fits it, and remembers the height it was given.
    expect(title.text.split("\n")).toHaveLength(1);
    expect(rect.height).toBe(cardHeight(1));
    expect(rect.customData!.excaliagent.appHeight).toBe(rect.height);
    expect(rect.y + PAD + 1 * TITLE_SIZE * TITLE_LH + TITLE_GAP + DETAIL_LINES * DETAIL_SIZE * DETAIL_LH + PAD).toBeLessThanOrEqual(rect.y + rect.height);
  });

  it("cardHeight fits one or two title lines above five detail lines; CARD_H is the two-line height", () => {
    expect(cardHeight(2)).toBe(CARD_H);
    expect(cardHeight(1)).toBe(Math.ceil(PAD + TITLE_H + TITLE_GAP + DETAIL_LINES * DETAIL_SIZE * DETAIL_LH + PAD));
    expect(cardHeight(1)).toBe(CARD_H - TITLE_H);
    expect(cardHeight(0)).toBe(cardHeight(1));
    expect(cardHeight(3)).toBe(CARD_H);
  });

  it("a two-line title gets the full height, remembered as the app-set height", () => {
    const s = session({ title: "A rather long title that certainly wraps onto a second line" });
    const [rect, title, details] = makeCard(s, { x: 0, y: 0 }, testGen(), NOW);
    expect(title.text.split("\n")).toHaveLength(2);
    expect(rect.height).toBe(CARD_H);
    expect(rect.customData!.excaliagent.appHeight).toBe(CARD_H);
    expect(details.y + details.height + PAD).toBeLessThanOrEqual(rect.y + rect.height);
  });
});

describe("makeInbox", () => {
  it("creates an inbox rectangle with its title bound inside, at the top", () => {
    const els = makeInbox(testGen(), NOW);
    const rect = els.find((e) => e.type === "rectangle")!;
    expect(rect.customData).toEqual({ excaliagent: { kind: "inbox" } });
    const label = els.find((e) => e.type === "text");
    expect(label).toMatchObject({ text: "Inbox", containerId: rect.id, verticalAlign: "top" });
    expect(label!.y).toBeGreaterThan(rect.y);
  });
});

describe("shortPr / prLink", () => {
  it.each([
    ["https://github.com/me/repo/pull/12", "PR #12"],
    ["https://bitbucket.org/team/repo/pull-requests/34", "PR #34"],
    ["https://git.example.com/projects/X/repos/y/pull-requests/5", "PR #5"],
    ["https://gitlab.com/group/sub/repo/-/merge_requests/7", "MR !7"],
    ["https://gitlab.example.com/x/-/merge_requests/8/diffs", "MR !8"],
    ["https://example.com/something/else", "example.com/something/else"],
  ])("%s → %s", (url, out) => expect(shortPr(url)).toBe(out));

  it("prLink is the last PR url, or null", () => {
    expect(prLink(session({ prLinks: ["https://a/1", "https://b/2"] }))).toBe("https://b/2");
    expect(prLink(session({ prLinks: [] }))).toBeNull();
  });

  it("the card rect links to the last PR", () => {
    const [rect] = makeCard(session({ prLinks: ["https://github.com/a/b/pull/3"] }), { x: 0, y: 0 }, testGen(), NOW);
    expect(rect.link).toBe("https://github.com/a/b/pull/3");
    expect(makeCard(session(), { x: 0, y: 0 }, testGen(), NOW)[0].link).toBeNull();
  });
});

describe("harness logo", () => {
  it("makeCard adds the source's logo in the rect's top-right corner, in the card's group", () => {
    const [rect, title, , logo] = makeCard(session(), { x: 60, y: 100 }, testGen(), NOW);
    expect(logo).toMatchObject({
      type: "image",
      fileId: LOGOS.claude.fileId,
      status: "saved",
      scale: [1, 1],
      crop: null,
      x: 60 + CARD_W - PAD - LOGO_SIZE,
      y: 100 + PAD + (TITLE_H - LOGO_SIZE) / 2,
      width: LOGO_SIZE,
      height: LOGO_SIZE,
      groupIds: rect.groupIds,
      customData: { excaliagent: { kind: "card-logo", sessionId: "s1", cardId: rect.id } },
    });
    // The title wraps short of the logo.
    expect(title.x + TITLE_W).toBeLessThan(logo!.x);
  });

  it("makeCardLogo follows a resized rect's right edge, and is undefined for a source without a logo", () => {
    const rect = { id: "r", x: 10, y: 20, width: 400, groupIds: ["g"] };
    expect(makeCardLogo(rect, "s1", "claude", testGen(), NOW)!.x).toBe(10 + 400 - PAD - LOGO_SIZE);
    expect(makeCardLogo(rect, "s1", "other" as "claude", testGen(), NOW)).toBeUndefined();
  });

  it("titles wrap to the narrower width beside the logo", () => {
    const m: Measure = (t) => t.length * 10;
    const t = titleText(session({ title: "x".repeat(25) }), m); // 250px: fits INNER_W, not TITLE_W
    expect(INNER_W).toBeGreaterThanOrEqual(250);
    expect(t.split("\n")).toHaveLength(2);
  });
});

describe("character", () => {
  it("makeCard adds the session's character top-left, in the card's group; the title sits right of it, details full width below", () => {
    const els = makeCard(session(), { x: 60, y: 100 }, testGen(), NOW, undefined, "excaliagent-emoji-1f431");
    const [rect, title, details] = els;
    const character = els.find((e) => e.customData?.excaliagent?.kind === "card-character")!;
    expect(character).toMatchObject({
      type: "image",
      fileId: "excaliagent-emoji-1f431",
      status: "saved",
      x: 60 + PAD,
      y: 100 + PAD,
      width: AVATAR_SIZE,
      height: AVATAR_SIZE,
      groupIds: rect.groupIds,
      customData: { excaliagent: { kind: "card-character", sessionId: "s1", cardId: rect.id } },
    });
    expect(title.x).toBeGreaterThan(character.x + character.width);
    expect(details.x).toBe(rect.x + PAD);
    expect(details.x + TEXT_W).toBe(rect.x + CARD_W - PAD);
    expect(rect.customData!.excaliagent.charLayout).toBe(1);
  });

  it("the character ends above the details for one- and two-line titles", () => {
    for (const title of ["Short", "A rather long title that certainly wraps onto a second line"]) {
      const els = makeCard(session({ title }), { x: 0, y: 0 }, testGen(), NOW, undefined, "excaliagent-emoji-1f431");
      const details = els[2];
      const character = els.find((e) => e.customData?.excaliagent?.kind === "card-character")!;
      expect(character.y + character.height).toBeLessThan(details.y);
    }
  });

  it("a card made without a character file id is not marked as laid out for one", () => {
    expect(makeCard(session(), { x: 0, y: 0 }, testGen(), NOW)[0].customData!.excaliagent.charLayout).toBeUndefined();
  });

  it("makeCard without a character file id has no character", () => {
    const els = makeCard(session(), { x: 0, y: 0 }, testGen(), NOW);
    expect(els.some((e) => e.customData?.excaliagent?.kind === "card-character")).toBe(false);
  });

  it("makeCardCharacter places it at the rect's current top-left", () => {
    const c = makeCardCharacter({ id: "r", x: 10, y: 20, groupIds: ["g"] }, "s1", "excaliagent-emoji-1f436", testGen(), NOW);
    expect(c).toMatchObject({ x: 10 + PAD, y: 20 + PAD, groupIds: ["g"], fileId: "excaliagent-emoji-1f436" });
  });
});
