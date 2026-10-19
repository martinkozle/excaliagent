// Card building blocks: colours, label text, and raw Excalidraw elements.
//
// Pure and DOM-free on purpose: elements are built as plain objects instead of
// via `convertToExcalidrawElements`, so this runs in node tests. Text layout is
// deterministic: the label is left/top aligned inside its container, so its
// position is `container + BOUND_TEXT_PADDING` and its height is
// `lines * fontSize * lineHeight`; only the width would need a DOM to measure,
// and we use the container's inner width instead. Lines are truncated so they
// do not wrap at the card's default width.
import type {
  ExcalidrawElement,
  ExcalidrawRectangleElement,
  ExcalidrawTextElement,
  FontFamilyValues,
} from "@excalidraw/excalidraw/element/types";
import { NEEDS_INPUT, type Session } from "../shared/types.ts";

export type Element = ExcalidrawElement;

/** Injected randomness, so tests are deterministic. */
export interface Gen {
  id(): string;
  /** Random positive int; used for `seed` and `versionNonce`. */
  seed(): number;
}

export const defaultGen: Gen = {
  id: () => crypto.randomUUID().replace(/-/g, "").slice(0, 20),
  seed: () => Math.floor(Math.random() * 2 ** 31),
};

export const CARD_W = 280;
export const CARD_H = 120;
export const FONT_SIZE = 14;
/** FONT_FAMILY.Nunito in Excalidraw 0.18 (normal sans serif). */
export const FONT_FAMILY = 6 as FontFamilyValues;
/** Nunito's line height in Excalidraw 0.18's font metadata. */
export const LINE_HEIGHT = 1.35;
/** Excalidraw's BOUND_TEXT_PADDING. */
export const TEXT_PADDING = 5;
/** Max characters per label line; ~7px per char at 14px Nunito keeps it < 270px. */
export const MAX_LINE = 36;

export const INBOX_W = 920;
export const INBOX_H = 560;
export const INBOX_ORIGIN = { x: 40, y: 80 };

export type CardMeta = { kind: "card"; source: Session["source"]; sessionId: string };
export type InboxMeta = { kind: "inbox" } | { kind: "inbox-label" };

export interface CardStyle {
  backgroundColor: string;
  strokeColor: string;
  strokeStyle: "solid" | "dashed";
  fillStyle: "solid";
}

const DORMANT: CardStyle = { backgroundColor: "#f8f9fa", strokeColor: "#adb5bd", strokeStyle: "dashed", fillStyle: "solid" };

export function isDormant(s: Session): boolean {
  return !s.live || s.status === "dormant" || s.status === "exited";
}

/** DESIGN.md "Status → color". `undefined` = session unknown → dormant look. */
export function statusStyle(s: Session | undefined, now: number): CardStyle {
  if (!s || isDormant(s)) return DORMANT;
  if (NEEDS_INPUT.has(s.status))
    return { backgroundColor: "#ffc9c9", strokeColor: "#e03131", strokeStyle: "solid", fillStyle: "solid" };
  if (s.status === "busy")
    return { backgroundColor: "#a5d8ff", strokeColor: "#1971c2", strokeStyle: "solid", fillStyle: "solid" };
  if (s.cacheExpiresAt > now)
    return { backgroundColor: "#b2f2bb", strokeColor: "#2f9e44", strokeStyle: "solid", fillStyle: "solid" };
  return { backgroundColor: "#e9ecef", strokeColor: "#868e96", strokeStyle: "solid", fillStyle: "solid" };
}

/** "now" under a minute, then "2m", "3h", "4d" (floored). */
export function formatAge(ms: number): string {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function shortPr(url: string): string {
  const m = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/.exec(url);
  return m ? `PR #${m[1]}` : url.replace(/^https?:\/\//, "");
}

function truncate(line: string): string {
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE - 1)}…` : line;
}

/** DESIGN.md "Card label": up to five lines, empty ones dropped. */
export function labelText(s: Session, now: number): string {
  const dormant = isDormant(s);
  const age = formatAge(now - s.lastActivityAt);
  const title = s.title || s.name || s.repo;
  const where = [s.repo, s.branch].filter(Boolean).join(" · ");
  let state: string;
  if (dormant) state = `${s.status === "exited" ? "exited" : "dormant"} · ${age}`;
  else {
    const st = s.status.replace(/_/g, " ");
    state = `${s.waitingFor ? `${st}: ${s.waitingFor}` : st} · ${age}`;
  }
  const extra: string[] = [];
  if (s.cacheExpiresAt !== 0) {
    const left = s.cacheExpiresAt - now;
    extra.push(left > 0 ? `cache warm ${Math.ceil(left / 60_000)}m` : "cache cold");
  }
  if (!dormant) extra.push(s.pane ? `herdr ${s.pane.paneId}` : "no pane");
  const pr = s.prLinks.length ? shortPr(s.prLinks[s.prLinks.length - 1]!) : "";
  return [title, where, state, extra.join(" · "), pr]
    .filter((l) => l)
    .map(truncate)
    .join("\n");
}

/** Height of a bound label with `text`'s line count (Excalidraw's getTextHeight). */
export function textHeight(text: string, fontSize = FONT_SIZE, lineHeight = LINE_HEIGHT): number {
  return text.split("\n").length * fontSize * lineHeight;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function base(gen: Gen, now: number) {
  return {
    angle: 0 as ExcalidrawElement["angle"],
    strokeWidth: 2,
    roughness: 0,
    opacity: 100,
    groupIds: [] as string[],
    frameId: null,
    seed: gen.seed(),
    version: 1,
    versionNonce: gen.seed(),
    isDeleted: false,
    updated: now,
    link: null,
    locked: false,
    // null = "not yet placed"; Excalidraw's scene assigns fractional indices.
    index: null,
  };
}

function textElement(
  gen: Gen,
  now: number,
  o: Pick<ExcalidrawTextElement, "x" | "y" | "width" | "text" | "containerId" | "fontSize" | "textAlign" | "verticalAlign">,
  customData?: Record<string, unknown>,
): Mutable<ExcalidrawTextElement> {
  return {
    ...base(gen, now),
    id: gen.id(),
    type: "text",
    x: o.x,
    y: o.y,
    width: o.width,
    height: textHeight(o.text, o.fontSize),
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeStyle: "solid",
    strokeWidth: 1,
    roundness: null,
    boundElements: null,
    text: o.text,
    originalText: o.text,
    fontSize: o.fontSize,
    fontFamily: FONT_FAMILY,
    textAlign: o.textAlign,
    verticalAlign: o.verticalAlign,
    containerId: o.containerId,
    autoResize: true,
    lineHeight: LINE_HEIGHT as ExcalidrawTextElement["lineHeight"],
    ...(customData ? { customData } : {}),
  };
}

/** A card rectangle plus its bound label. */
export function makeCard(
  s: Session,
  at: { x: number; y: number },
  gen: Gen,
  now: number,
): [ExcalidrawRectangleElement, ExcalidrawTextElement] {
  const rectId = gen.id();
  const text = textElement(gen, now, {
    x: at.x + TEXT_PADDING,
    y: at.y + TEXT_PADDING,
    width: CARD_W - 2 * TEXT_PADDING,
    text: labelText(s, now),
    containerId: rectId,
    fontSize: FONT_SIZE,
    textAlign: "left",
    verticalAlign: "top",
  });
  const meta: CardMeta = { kind: "card", source: s.source, sessionId: s.id };
  const rect: ExcalidrawRectangleElement = {
    ...base(gen, now),
    id: rectId,
    type: "rectangle",
    x: at.x,
    y: at.y,
    width: CARD_W,
    height: CARD_H,
    ...statusStyle(s, now),
    roundness: { type: 3 },
    boundElements: [{ type: "text", id: text.id }],
    customData: { excaliagent: meta },
  };
  return [rect, text];
}

/** The inbox rectangle plus a free "inbox" title just above it. */
export function makeInbox(gen: Gen, now: number, at = INBOX_ORIGIN): [ExcalidrawRectangleElement, ExcalidrawTextElement] {
  const rect: ExcalidrawRectangleElement = {
    ...base(gen, now),
    id: gen.id(),
    type: "rectangle",
    x: at.x,
    y: at.y,
    width: INBOX_W,
    height: INBOX_H,
    strokeColor: "#868e96",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeStyle: "dashed",
    strokeWidth: 1,
    roundness: { type: 3 },
    boundElements: null,
    customData: { excaliagent: { kind: "inbox" } satisfies InboxMeta },
  };
  const fontSize = 20;
  const label = textElement(
    gen,
    now,
    {
      x: at.x,
      y: at.y - fontSize * LINE_HEIGHT - 8,
      width: 60,
      text: "inbox",
      containerId: null,
      fontSize,
      textAlign: "left",
      verticalAlign: "top",
    },
    { excaliagent: { kind: "inbox-label" } satisfies InboxMeta },
  );
  label.strokeColor = "#868e96";
  return [rect, label];
}

export function cardMeta(e: ExcalidrawElement): CardMeta | undefined {
  const m = e.customData?.excaliagent;
  return e.type === "rectangle" && m?.kind === "card" && typeof m.sessionId === "string" ? (m as CardMeta) : undefined;
}

export function isInbox(e: ExcalidrawElement): boolean {
  return e.type === "rectangle" && !e.isDeleted && e.customData?.excaliagent?.kind === "inbox";
}
