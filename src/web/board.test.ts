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
  const menu = { left: 100, top: 400, bottom: 600, width: 180 };
  it("sits directly above the menu, same left and width", () => {
    expect(menuPlacement(menu, 3, 900)).toEqual({ left: 100, width: 180, bottom: 900 - 400 });
  });
  it("goes below the menu when there is no room above", () => {
    expect(menuPlacement({ ...menu, top: 30, bottom: 230 }, 3, 900)).toEqual({ left: 100, width: 180, top: 230 });
  });
});
