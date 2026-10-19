// Card building blocks: colours, title/details text, and raw Excalidraw elements.
//
// A card is three app-owned elements sharing a fresh group (first = innermost
// in `groupIds`): a rectangle, a title text (Excalifont 20) and a details text
// (Nunito 14). Neither text is bound to the rectangle: Excalidraw allows one
// bound text per container and one font size per text element.
//
// Pure and DOM-free: elements are plain objects (no `convertToExcalidrawElements`),
// so this runs in node tests. Text height is deterministic (lines × size ×
// lineHeight, as Excalidraw computes it). Text width comes from an injectable
// `Measure` (the browser passes a canvas measurer from measure.ts; the default
// is a conservative per-char estimate). Excalidraw may re-measure widths later;
// reconcile compares on `originalText`, so that never counts as a change.
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

export const CARD_W = 300;
export const PAD = 14;
export const TITLE_GAP = 8;
export const DETAIL_LINES = 5;
export const TITLE_MAX_LINES = 2;

export const TITLE_SIZE = 20;
/** FONT_FAMILY.Excalifont in Excalidraw 0.18. */
export const TITLE_FONT = 5 as FontFamilyValues;
export const TITLE_LH = 1.25;
export const TITLE_COLOR = "#1e1e1e";

export const DETAIL_SIZE = 14;
/** FONT_FAMILY.Nunito in Excalidraw 0.18. */
export const DETAIL_FONT = 6 as FontFamilyValues;
export const DETAIL_LH = 1.35;
export const DETAIL_COLOR = "#495057";

/** Width in px of a single line of text. */
export type Measure = (text: string, fontFamily: number, fontSize: number) => number;

/** Conservative average glyph width / font size: Excalifont 0.6, others 0.55. */
export const estimateMeasure: Measure = (text, fontFamily, fontSize) =>
  text.length * fontSize * (fontFamily === TITLE_FONT ? 0.6 : 0.55);

export const INNER_W = CARD_W - 2 * PAD;

export const TITLE_H = TITLE_SIZE * TITLE_LH;
/** Fits two title lines and five detail lines. */
export const CARD_H = Math.ceil(PAD + TITLE_MAX_LINES * TITLE_H + TITLE_GAP + DETAIL_LINES * DETAIL_SIZE * DETAIL_LH + PAD);

export const INBOX_W = 20 + 3 * (CARD_W + 20);
export const INBOX_H = 20 + 4 * (CARD_H + 20);
export const INBOX_ORIGIN = { x: 40, y: 80 };

export type CardMeta = { kind: "card"; source: Session["source"]; sessionId: string };
export type CardPartKind = "card-title" | "card-details";
export type CardPartMeta = { kind: CardPartKind; sessionId: string; cardId: string };
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

/** docs/design.md "Cards" colour table. `undefined` = session unknown → dormant look. */
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

/**
 * "PR #N" for GitHub `/pull/N` and Bitbucket `/pull-requests/N`, "MR !N" for
 * GitLab `/-/merge_requests/N`, else the URL without its scheme.
 */
export function shortPr(url: string): string {
  const mr = /^https?:\/\/[^/]+\/.+\/-\/merge_requests\/(\d+)(?:[/?#]|$)/.exec(url);
  if (mr) return `MR !${mr[1]}`;
  const pr = /^https?:\/\/[^/]+\/.+\/(?:pull|pull-requests)\/(\d+)(?:[/?#]|$)/.exec(url);
  if (pr) return `PR #${pr[1]}`;
  return url.replace(/^https?:\/\//, "");
}

/** The card rect's `link`: the session's last PR url, or null. */
export function prLink(s: Session): string | null {
  return s.prLinks.at(-1) ?? null;
}

type Fits = (text: string) => boolean;

function fitsWith(measure: Measure, fontFamily: number, fontSize: number): Fits {
  return (t) => measure(t, fontFamily, fontSize) <= INNER_W;
}

/** Longest prefix that fits with a trailing "…" (whole `text` if it fits). */
function ellipsize(text: string, fits: Fits): string {
  if (fits(text)) return text;
  let n = text.length - 1;
  while (n > 0 && !fits(`${text.slice(0, n).trimEnd()}…`)) n--;
  return `${text.slice(0, n).trimEnd()}…`;
}

/** First wrapped line of `text` (word-wise, chars for an over-long first word) and the rest. */
function splitLine(text: string, fits: Fits): [string, string] {
  if (fits(text)) return [text, ""];
  const words = text.split(" ");
  let line = "";
  let i = 0;
  for (; i < words.length; i++) {
    const cand = line ? `${line} ${words[i]}` : words[i]!;
    if (!fits(cand)) break;
    line = cand;
  }
  if (line) return [line, words.slice(i).join(" ")];
  const w = words[0]!;
  let n = 1;
  while (n < w.length && fits(w.slice(0, n + 1))) n++;
  return [w.slice(0, n), [w.slice(n), ...words.slice(1)].join(" ")];
}

/** Word-wrap to at most two lines; only the second is cut with "…". */
export function wrapTitle(raw: string, measure: Measure = estimateMeasure): string {
  const fits = fitsWith(measure, TITLE_FONT, TITLE_SIZE);
  const text = raw.replace(/\s+/g, " ").trim();
  const [l1, rest] = splitLine(text, fits);
  if (!rest) return l1;
  const [l2, rest2] = splitLine(rest, fits);
  return `${l1}\n${rest2 ? ellipsize(rest, fits) : l2}`;
}

/** ai-title, else registry name, else repo; wrapped to at most two lines. */
export function titleText(s: Session, measure: Measure = estimateMeasure): string {
  return wrapTitle(s.title || s.name || s.repo, measure);
}

function herdrLine(s: Session): string {
  if (!s.pane) return "not in herdr";
  const labels = [s.pane.workspaceLabel, s.pane.tabLabel].filter(Boolean);
  return `herdr: ${labels.length ? labels.join(" › ") : s.pane.paneId}`;
}

/** Up to five lines (docs/design.md "Cards"), empty ones dropped. */
export function detailsText(s: Session, now: number, measure: Measure = estimateMeasure): string {
  const dormant = isDormant(s);
  const age = formatAge(now - s.lastActivityAt);
  const where = [s.repo, s.branch].filter(Boolean).join(" · ");
  let state: string;
  if (dormant) state = `${s.status === "exited" ? "exited" : "dormant"} · ${age}`;
  else {
    const st = s.status.replace(/_/g, " ");
    state = `${s.waitingFor ? `${st}: ${s.waitingFor}` : st} · ${age}`;
  }
  let cache = "";
  if (s.cacheExpiresAt !== 0) {
    const left = s.cacheExpiresAt - now;
    cache = left > 0 ? `cache warm ${Math.ceil(left / 60_000)}m` : "cache cold";
  }
  const herdr = dormant ? "" : herdrLine(s);
  const pr = s.prLinks.length ? shortPr(s.prLinks[s.prLinks.length - 1]!) : "";
  const fits = fitsWith(measure, DETAIL_FONT, DETAIL_SIZE);
  return [where, state, cache, herdr, pr]
    .filter((l) => l)
    .map((l) => ellipsize(l, fits))
    .join("\n");
}

/** Box of a free (auto-resizing) text element of `part`. */
export function partBox(
  part: CardPartKind,
  text: string,
  measure: Measure = estimateMeasure,
): { width: number; height: number } {
  const title = part === "card-title";
  const [family, size, lh] = title ? [TITLE_FONT, TITLE_SIZE, TITLE_LH] : [DETAIL_FONT, DETAIL_SIZE, DETAIL_LH];
  const lines = text.split("\n");
  return {
    width: Math.min(INNER_W, Math.ceil(Math.max(...lines.map((l) => measure(l, family, size))))),
    height: lines.length * size * lh,
  };
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
  o: Pick<ExcalidrawTextElement, "x" | "y" | "text" | "fontSize" | "fontFamily" | "strokeColor" | "groupIds"> & {
    lineHeight: number;
    width: number;
    height: number;
  },
  customData?: Record<string, unknown>,
): Mutable<ExcalidrawTextElement> {
  return {
    ...base(gen, now),
    id: gen.id(),
    type: "text",
    x: o.x,
    y: o.y,
    width: o.width,
    height: o.height,
    strokeColor: o.strokeColor,
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeStyle: "solid",
    strokeWidth: 1,
    roundness: null,
    boundElements: null,
    groupIds: o.groupIds,
    text: o.text,
    originalText: o.text,
    fontSize: o.fontSize,
    fontFamily: o.fontFamily,
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    autoResize: true,
    lineHeight: o.lineHeight as ExcalidrawTextElement["lineHeight"],
    ...(customData ? { customData } : {}),
  };
}

/** Where a card part sits relative to its rect's top-left; details follow the title's line count. */
export function partOffset(part: CardPartKind, titleLines = 1): { dx: number; dy: number } {
  return part === "card-title" ? { dx: PAD, dy: PAD } : { dx: PAD, dy: PAD + titleLines * TITLE_H + TITLE_GAP };
}

export const lineCount = (text: string) => text.split("\n").length;

/** A title or details text for the card `rect`, placed at the rect's current position. */
export function makeCardPart(
  part: CardPartKind,
  rect: Pick<ExcalidrawElement, "id" | "x" | "y" | "groupIds">,
  sessionId: string,
  text: string,
  gen: Gen,
  now: number,
  measure: Measure = estimateMeasure,
  titleLines = 1,
): ExcalidrawTextElement {
  const { dx, dy } = partOffset(part, titleLines);
  const title = part === "card-title";
  const meta: CardPartMeta = { kind: part, sessionId, cardId: rect.id };
  return textElement(
    gen,
    now,
    {
      x: rect.x + dx,
      y: rect.y + dy,
      text,
      ...partBox(part, text, measure),
      fontSize: title ? TITLE_SIZE : DETAIL_SIZE,
      fontFamily: title ? TITLE_FONT : DETAIL_FONT,
      lineHeight: title ? TITLE_LH : DETAIL_LH,
      strokeColor: title ? TITLE_COLOR : DETAIL_COLOR,
      groupIds: [...rect.groupIds],
    },
    { excaliagent: meta },
  );
}

/** A new card: rect, title, details, all in one fresh group. */
export function makeCard(
  s: Session,
  at: { x: number; y: number },
  gen: Gen,
  now: number,
  measure: Measure = estimateMeasure,
): [ExcalidrawRectangleElement, ExcalidrawTextElement, ExcalidrawTextElement] {
  const meta: CardMeta = { kind: "card", source: s.source, sessionId: s.id };
  const rect: ExcalidrawRectangleElement = {
    ...base(gen, now),
    id: gen.id(),
    type: "rectangle",
    x: at.x,
    y: at.y,
    width: CARD_W,
    height: CARD_H,
    groupIds: [gen.id()],
    ...statusStyle(s, now),
    roundness: { type: 3 },
    boundElements: null,
    link: prLink(s),
    customData: { excaliagent: meta },
  };
  const title = titleText(s, measure);
  return [
    rect,
    makeCardPart("card-title", rect, s.id, title, gen, now, measure),
    makeCardPart("card-details", rect, s.id, detailsText(s, now, measure), gen, now, measure, lineCount(title)),
  ];
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
  const label = textElement(
    gen,
    now,
    {
      x: at.x,
      y: at.y - TITLE_H - 8,
      text: "inbox",
      ...partBox("card-title", "inbox"),
      fontSize: TITLE_SIZE,
      fontFamily: TITLE_FONT,
      lineHeight: TITLE_LH,
      strokeColor: "#868e96",
      groupIds: [],
    },
    { excaliagent: { kind: "inbox-label" } satisfies InboxMeta },
  );
  return [rect, label];
}

export function cardMeta(e: ExcalidrawElement): CardMeta | undefined {
  const m = e.customData?.excaliagent;
  return e.type === "rectangle" && m?.kind === "card" && typeof m.sessionId === "string" ? (m as CardMeta) : undefined;
}

export function cardPartMeta(e: ExcalidrawElement): CardPartMeta | undefined {
  const m = e.customData?.excaliagent;
  return e.type === "text" && (m?.kind === "card-title" || m?.kind === "card-details") && typeof m.sessionId === "string"
    ? (m as CardPartMeta)
    : undefined;
}

export function isInbox(e: ExcalidrawElement): boolean {
  return e.type === "rectangle" && !e.isDeleted && e.customData?.excaliagent?.kind === "inbox";
}
