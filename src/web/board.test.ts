import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { describe, expect, it } from "vitest";
import { makeCard } from "./cards.ts";
import type { Session } from "../shared/types.ts";
import {
  cardAt,
  logoAt,
  cardSessionIds,
  idsToLookup,
  menuItems,
  menuPlacement,
  mergeSessions,
  resumeCommand,
  saveHash,
  filesToUpload,
  imageFileIds,
  laneMenuItems,
  readLaneDrop,
  writeLaneDrop,
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
  it("prefixes the server's command with a cd, quoting the cwd for the shell", () => {
    expect(resumeCommand(session({ id: "abc", cwd: "/home/me/it's here" }))).toBe(
      "cd '/home/me/it'\\''s here' && claude --resume abc",
    );
    expect(resumeCommand(session({ source: "codex", cwd: "/w", resumeCommand: "codex resume abc" }))).toBe("cd '/w' && codex resume abc");
  });
  it("is undefined without a server command", () => {
    expect(resumeCommand(session({ resumeCommand: undefined }))).toBeUndefined();
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

describe("menuItems", () => {
  const labels = (s: Session | undefined) => menuItems(s).map((i) => i.label);

  it("live with pane: focus, copies, PR, then stop (last, it is destructive)", () => {
    const s = session({ prLinks: ["https://github.com/a/b/pull/12"] });
    expect(menuItems(s)).toEqual([
      { action: "focus", label: "Focus pane" },
      { action: "copy", label: "Copy resume command", text: "claude --resume s1" },
      { action: "copy", label: "Copy resume command with cd", text: resumeCommand(s) },
      { action: "open", label: "Open PR #12", url: "https://github.com/a/b/pull/12" },
      { action: "character", label: "Change character…" },
      { action: "end", label: "Stop session…" },
    ]);
  });

  it("live without pane: no focus, but it can be stopped", () => {
    expect(labels(session({ pane: undefined }))).toEqual(["Copy resume command", "Copy resume command with cd", "Change character…", "Stop session…"]);
  });

  it("dormant: resume in herdr first; MR label", () => {
    const s = session({ live: false, status: "dormant", prLinks: ["https://gitlab.com/g/r/-/merge_requests/3"] });
    expect(labels(s)).toEqual(["Resume in herdr", "Copy resume command", "Copy resume command with cd", "Open MR !3", "Change character…"]);
  });

  it("no Stop when the server cannot tell the process for sure (canEnd unset)", () => {
    expect(labels(session({ source: "codex", canEnd: undefined }))).not.toContain("Stop session…");
  });

  it("unknown session: only Change character… (only the server knows how to resume it)", () => {
    expect(labels(undefined)).toEqual(["Change character…"]);
  });

  it("copies whatever command the server built for the harness", () => {
    const s = session({ id: "t1", source: "codex", cwd: "/w", live: false, status: "dormant", resumeCommand: "codex resume t1" });
    expect(menuItems(s).filter((i) => i.action === "copy")).toEqual([
      { action: "copy", label: "Copy resume command", text: "codex resume t1" },
      { action: "copy", label: "Copy resume command with cd", text: "cd '/w' && codex resume t1" },
    ]);
  });

  it("non-standard PR url: generic label", () => {
    expect(labels(session({ live: false, status: "dormant", prLinks: ["https://x.example/y"] })).at(-2)).toBe("Open PR");
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
    const isLogo = (id: string) => id === "logo";
    expect(filesToUpload(elements, files, new Set(), isLogo)).toEqual([file("shot")]);
    expect(filesToUpload(elements, files, new Set(["shot"]), isLogo)).toEqual([]);
    expect(filesToUpload(elements, {} as never, new Set(), () => false)).toEqual([]);
  });
});

describe("laneMenuItems", () => {
  it("a lane offers Tidy cards", () => {
    expect(laneMenuItems()).toEqual([{ action: "tidy", label: "Tidy cards" }]);
  });
});

describe("lane drop setting", () => {
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };

  it("is on by default and round-trips off/on", () => {
    const s = store();
    expect(readLaneDrop(s)).toBe(true);
    writeLaneDrop(false, s);
    expect(readLaneDrop(s)).toBe(false);
    writeLaneDrop(true, s);
    expect(readLaneDrop(s)).toBe(true);
  });

  it("fails soft: storage that throws (or is missing) reads as on and ignores writes", () => {
    const broken = {
      getItem: (): string | null => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readLaneDrop(broken)).toBe(true);
    expect(() => writeLaneDrop(false, broken)).not.toThrow();
    expect(readLaneDrop(undefined)).toBe(true);
  });
});

describe("logoAt", () => {
  const full = (id: string, x = 0, y = 0) =>
    makeCard(session({ id }), { x, y }, testGen(), NOW) as unknown as ExcalidrawElement[];
  const logoOf = (els: readonly ExcalidrawElement[]) => els.find((e) => e.customData?.excaliagent?.kind === "card-logo")!;
  const centre = (e: ExcalidrawElement) => [e.x + e.width / 2, e.y + e.height / 2] as const;

  it("finds the session whose harness logo is under the scene point", () => {
    const a = full("a");
    const b = full("b", 400, 0);
    const els = [...a, ...b];
    const [x, y] = centre(logoOf(b));
    expect(logoAt(els, x, y)).toBe("b");
    const la = logoOf(a);
    expect(logoAt(els, la.x + 1, la.y + 1)).toBe("a");
    expect(logoAt(els, la.x + la.width - 1, la.y + la.height - 1)).toBe("a");
  });

  it("is undefined elsewhere on the card, and off it", () => {
    const els = full("a");
    const rect = els[0]!;
    expect(logoAt(els, rect.x + 30, rect.y + rect.height / 2)).toBeUndefined();
    const l = logoOf(els);
    expect(logoAt(els, l.x - 6, l.y + l.height / 2)).toBeUndefined();
    expect(logoAt(els, 5000, 5000)).toBeUndefined();
  });

  it("ignores a deleted logo and a logo whose card is deleted", () => {
    const els = full("a");
    const [x, y] = centre(logoOf(els));
    const isLogo = (e: ExcalidrawElement) => e.customData?.excaliagent?.kind === "card-logo";
    expect(logoAt(els.map((e) => (isLogo(e) ? { ...e, isDeleted: true } : e)), x, y)).toBeUndefined();
    expect(logoAt(els.map((e) => (e.type === "rectangle" ? { ...e, isDeleted: true } : e)), x, y)).toBeUndefined();
  });

  it("does not reach through something filled lying on top of the logo", () => {
    const els = full("a");
    const l = logoOf(els);
    const [x, y] = centre(l);
    const note = { ...els[0]!, id: "note", x: l.x - 10, y: l.y - 10, width: 60, height: 60, backgroundColor: "#ffec99", customData: undefined };
    expect(logoAt([...els, note as ExcalidrawElement], x, y)).toBeUndefined();
    // An unfilled outline on top lets clicks through, as in Excalidraw.
    expect(logoAt([...els, { ...note, backgroundColor: "transparent" } as ExcalidrawElement], x, y)).toBe("a");
  });

  it("follows a rotated card's logo", () => {
    const els = full("a");
    const rect = els[0]!;
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    // Turn every element by 180° around the card's centre, as rotating the group does.
    const turn = (e: ExcalidrawElement) => {
      const ex = e.x + e.width / 2;
      const ey = e.y + e.height / 2;
      return { ...e, x: 2 * cx - ex - e.width / 2, y: 2 * cy - ey - e.height / 2, angle: Math.PI } as ExcalidrawElement;
    };
    const rotated = els.map(turn);
    const [x, y] = centre(logoOf(rotated));
    expect(logoAt(rotated, x, y)).toBe("a");
    const [ox, oy] = centre(logoOf(els)); // the logo's old place is the bottom-left corner now
    expect(logoAt(rotated, ox, oy)).toBeUndefined();
  });
});
