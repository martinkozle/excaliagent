import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { describe, expect, it } from "vitest";
import { makeCard } from "./cards.ts";
import type { Session } from "../shared/types.ts";
import {
  cardAt,
  cardSessionIds,
  idsToLookup,
  menuItems,
  menuPlacement,
  mergeSessions,
  resumeCommand,
  resumeCommandPlain,
  saveHash,
  filesToUpload,
  imageFileIds,
} from "./board.ts";
import { NOW, session, testGen } from "./__fixtures__/helpers.ts";

const card = (id: string, x = 0, y = 0, deleted = false) => {
  const [rect, text] = makeCard(session({ id }), { x, y }, testGen(), NOW);
  return [{ ...rect, id: `r-${id}`, isDeleted: deleted }, { ...text, id: `t-${id}`, containerId: `r-${id}` }] as ExcalidrawElement[];
};

describe("cardSessionIds", () => {
  it("collects session ids of non-deleted cards only", () => {
    const els = [...card("a"), ...card("b", 0, 0, true), ...card("c")];
    expect([...cardSessionIds(els)].sort()).toEqual(["a", "c"]);
  });
});

describe("mergeSessions", () => {
  it("live wins over known, known are forced non-live", () => {
    const live = [session({ id: "a", status: "busy" })];
    const known = new Map([
      ["a", session({ id: "a", status: "dormant", live: false })],
      ["b", session({ id: "b", status: "idle", live: true })],
    ]);
    const merged = mergeSessions(live, known);
    expect(merged.map((s) => [s.id, s.status, s.live])).toEqual([
      ["a", "busy", true],
      ["b", "idle", false],
    ]);
  });
});

describe("idsToLookup", () => {
  it("asks only for carded sessions we know nothing about", () => {
    const ids = idsToLookup(new Set(["a", "b", "c", "d"]), [session({ id: "a" })], new Map([["b", session({ id: "b" })]]), new Set(["c"]));
    expect(ids).toEqual(["d"]);
  });
});

describe("cardAt", () => {
  it("finds the topmost card under a scene point, via the card or its label", () => {
    const els = [...card("a", 0, 0), ...card("b", 100, 50)];
    expect(cardAt(els, 150, 100)).toBe("b");
    expect(cardAt(els, 10, 10)).toBe("a");
    expect(cardAt(els, 5000, 5000)).toBeUndefined();
  });
  it("ignores deleted cards", () => {
    expect(cardAt(card("a", 0, 0, true), 10, 10)).toBeUndefined();
  });
});

describe("resumeCommand", () => {
  it("quotes the cwd for the shell", () => {
    expect(resumeCommand(session({ id: "abc", cwd: "/home/me/it's here" }))).toBe(
      "cd '/home/me/it'\\''s here' && claude --resume abc",
    );
  });
});

describe("saveHash", () => {
  it("changes when any element version changes, not otherwise", () => {
    const els = card("a");
    const h = saveHash(els);
    expect(saveHash(els.map((e) => ({ ...e })))).toBe(h);
    expect(saveHash([{ ...els[0]!, version: els[0]!.version + 1 }, els[1]!])).not.toBe(h);
  });
});

describe("resume commands", () => {
  it("plain and with cd", () => {
    expect(resumeCommandPlain("abc")).toBe("claude --resume abc");
  });
});

describe("menuItems", () => {
  const labels = (s: Session | undefined, id = "s1") => menuItems(id, s).map((i) => i.label);

  it("live with pane: focus, copies, PR", () => {
    const s = session({ prLinks: ["https://github.com/a/b/pull/12"] });
    expect(menuItems("s1", s)).toEqual([
      { action: "focus", label: "Focus pane" },
      { action: "copy", label: "Copy resume command", text: "claude --resume s1" },
      { action: "copy", label: "Copy resume command with cd", text: resumeCommand(s) },
      { action: "open", label: "Open PR #12", url: "https://github.com/a/b/pull/12" },
    ]);
  });

  it("live without pane: no focus", () => {
    expect(labels(session({ pane: undefined }))).toEqual(["Copy resume command", "Copy resume command with cd"]);
  });

  it("dormant: resume in herdr first; MR label", () => {
    const s = session({ live: false, status: "dormant", prLinks: ["https://gitlab.com/g/r/-/merge_requests/3"] });
    expect(labels(s)).toEqual(["Resume in herdr", "Copy resume command", "Copy resume command with cd", "Open MR !3"]);
  });

  it("unknown session: only the plain copy", () => {
    expect(labels(undefined)).toEqual(["Copy resume command"]);
  });

  it("non-standard PR url: generic label", () => {
    expect(labels(session({ pane: undefined, prLinks: ["https://x.example/y"] })).at(-1)).toBe("Open PR");
  });
});

describe("menuPlacement", () => {
  const vp = { width: 1400, height: 900 };
  const panel = { width: 220, height: 150 };
  const menu = (left: number, top: number, width = 200, height = 400) => ({ left, top, width, height, right: left + width, bottom: top + height });

  it("sits right of the menu, top-aligned", () => {
    expect(menuPlacement(menu(100, 200), panel, vp)).toEqual({ left: 300 + 4, top: 200, width: 220, side: "right" });
  });

  it("goes left of the menu when the right side has no room", () => {
    expect(menuPlacement(menu(1100, 200), panel, vp)).toEqual({ left: 1100 - 4 - 220, top: 200, width: 220, side: "left" });
  });

  it("clamps vertically into the viewport", () => {
    expect(menuPlacement(menu(100, 850, 200, 40), panel, vp).top).toBe(900 - 150 - 8);
    expect(menuPlacement(menu(100, -20), panel, vp).top).toBe(8);
  });

  it("1920×1080 with Excalidraw's ~730px menu: fully visible, no overlap", () => {
    const view = { width: 1920, height: 1080 };
    for (const [x, y] of [[960, 300], [1700, 340], [200, 340], [1700, 0]] as const) {
      const m = menu(x, y, 230, 730);
      const p = menuPlacement(m, { width: 230, height: 190 }, view);
      expect(p.left).toBeGreaterThanOrEqual(0);
      expect(p.left + p.width).toBeLessThanOrEqual(view.width);
      expect(p.top).toBeGreaterThanOrEqual(0);
      expect(p.top + 190).toBeLessThanOrEqual(view.height);
      const overlapX = p.left < m.right && m.left < p.left + p.width;
      expect(overlapX).toBe(false);
    }
  });
});

describe("image files", () => {
  const img = (id: string, fileId: string | null, isDeleted = false) =>
    ({ id, type: "image", fileId, isDeleted }) as unknown as ExcalidrawElement;
  const file = (id: string) => ({ id, mimeType: "image/png", dataURL: `data:image/png;base64,${id}`, created: 1 });
  const elements = [
    img("e1", "shot"),
    img("e2", "logo"),
    img("e3", "gone", true),
    img("e4", null),
    img("e5", "shot"),
    { id: "r", type: "rectangle", isDeleted: false } as unknown as ExcalidrawElement,
  ];

  it("imageFileIds lists the files of live image elements once", () => {
    expect(imageFileIds(elements)).toEqual(["shot", "logo"]);
  });

  it("filesToUpload: files on the board not yet stored, never built-in ones, only when loaded", () => {
    const files = { shot: file("shot"), logo: file("logo"), gone: file("gone") } as never;
    expect(filesToUpload(elements, files, new Set(), new Set(["logo"]))).toEqual([file("shot")]);
    expect(filesToUpload(elements, files, new Set(["shot"]), new Set(["logo"]))).toEqual([]);
    expect(filesToUpload(elements, {} as never, new Set(), new Set())).toEqual([]);
  });
});
