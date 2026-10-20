import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  Sidebar,
  restoreElements,
  sceneCoordsToViewportCoords,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type { Session } from "../shared/types.ts";
import { api } from "./api.ts";
import {
  cardAt,
  cardSessionIds,
  filesToUpload,
  idsToLookup,
  imageFileIds,
  laneMenuItems,
  menuItems,
  mergeSessions,
  readLaneDrop,
  resumeCommand,
  saveHash,
  writeLaneDrop,
  type MenuItem,
} from "./board.ts";
import { CardMenu } from "./CardMenu.tsx";
import { defaultGen, formatAge } from "./cards.ts";
import { canvasMeasure } from "./measure.ts";
import { PlusIcon, SessionsIcon, TidyIcon, TopBar, TopButton } from "./TopBar.tsx";
import { topBarLayout } from "./topbar.ts";
import { reconcile } from "./reconcile.ts";
import { LOGOS, logoFiles } from "./logos.ts";
import {
  addLane,
  appendLanes,
  draggedCard,
  dropLaneAt,
  dropZone,
  lanesOf,
  zonesInView,
  laneTargetAt,
  moveCards,
  slotBelow,
  tidyAllMoves,
  tidyMoves,
} from "./lanes.ts";

// Serve Excalidraw's local fonts from our own server; missing fonts (Xiaolai CJK) fall back to CDN.
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = "/";

const PICKER = "excaliagent-picker";
const SAVE_DEBOUNCE_MS = 500;
const TICK_MS = 30_000;
const measure = canvasMeasure();

// Fonts are split into unicode-range faces; load the ones card text actually uses.
const SAMPLE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,:;·›…#-_/()";

/** Card text is wrapped by measured width, so wait for the real fonts (bounded). */
function fontsReady(): Promise<unknown> {
  const load = Promise.all([document.fonts.load("20px Excalifont", SAMPLE), document.fonts.load("14px Nunito", SAMPLE)]);
  return Promise.race([load, new Promise((r) => setTimeout(r, 3000))]).catch(() => {});
}

type Elements = readonly ExcalidrawElement[];

/** Logo images are part of the app: handed to Excalidraw on load, never stored. */
const BUILT_IN_FILES: ReadonlySet<string> = new Set(Object.values(LOGOS).map((l) => l.fileId));

const byId = (files: BinaryFileData[]): BinaryFiles => Object.fromEntries(files.map((f) => [f.id, f]));

/** localStorage, or undefined where the browser refuses it (the accessor itself can throw). */
function settingsStore(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/** What the right-click menu is for: a card (by session) or a lane. */
type MenuTarget = { kind: "card"; sessionId: string } | { kind: "lane"; laneId: string };

type ViewBox = { left: number; top: number; width: number; height: number };
/** The hovered drop zone and the outline of where the card will land, in viewport px. */
type DropHover = { laneId: string; cardId: string; zone: ViewBox; slot: ViewBox };
/** While a card is dragged: every visible lane's title band (faint), plus the hovered one (strong). */
type DropHint = { bands: Array<{ laneId: string; box: ViewBox }>; hover: DropHover | null };

/** A scene box in viewport (client) px. */
function toViewport(box: { x: number; y: number; width: number; height: number }, appState: AppState): ViewBox {
  const { x, y } = sceneCoordsToViewportCoords({ sceneX: box.x, sceneY: box.y }, appState);
  const z = appState.zoom.value;
  return { left: x, top: y, width: box.width * z, height: box.height * z };
}

export function App() {
  const [initialData, setInitialData] = useState<ExcalidrawInitialDataState | null>(null);
  const [excalidraw, setExcalidraw] = useState<ExcalidrawImperativeAPI | null>(null);
  const [connected, setConnected] = useState(true);
  const [pickerRows, setPickerRows] = useState<Session[] | null>(null);
  const [fontsLoaded, setFontsLoaded] = useState(false);
  /** Card or lane whose right-click menu is open. */
  const [menuFor, setMenuFor] = useState<MenuTarget | null>(null);
  /** Dropping a lone card on a lane's title band stacks it in the lane (setting, per browser). */
  const [laneDrop, setLaneDrop] = useState(() => readLaneDrop(settingsStore()));
  const [dropHint, setDropHint] = useState<DropHint | null>(null);

  const live = useRef<Session[]>([]);
  const known = useRef(new Map<string, Session>());
  const asked = useRef(new Set<string>());
  const lastSaved = useRef("");
  /** Image file ids the server has (or is being sent). */
  const storedFiles = useRef(new Set<string>());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    api
      .loadScene()
      .then(async (scene) => {
        const elements = restoreElements(scene.elements as ExcalidrawElement[], null);
        lastSaved.current = saveHash(elements.filter((e) => !e.isDeleted));
        const ids = imageFileIds(elements).filter((id) => !BUILT_IN_FILES.has(id));
        const files = await api.loadFiles(ids).catch((err: unknown) => {
          console.error("excaliagent: could not load images", err);
          return [];
        });
        for (const f of files) storedFiles.current.add(f.id);
        const bg = scene.appState.viewBackgroundColor;
        setInitialData({
          elements,
          appState: typeof bg === "string" ? { viewBackgroundColor: bg } : {},
          files: byId([...logoFiles(Date.now()), ...files]),
          scrollToContent: true,
        });
      })
      .catch((err: unknown) => {
        console.error("excaliagent: could not load scene", err);
        setInitialData({ elements: [], files: byId(logoFiles(Date.now())) });
      });
  }, []);

  /** Pasted images: their data lives apart from the elements, stored once per file. */
  const uploadFiles = useCallback((elements: Elements, files: BinaryFiles) => {
    const pending = filesToUpload(elements, files, storedFiles.current, BUILT_IN_FILES);
    if (!pending.length) return;
    for (const f of pending) storedFiles.current.add(f.id);
    api.saveFiles(pending).catch((err: unknown) => {
      for (const f of pending) storedFiles.current.delete(f.id);
      console.error("excaliagent: saving images failed", err);
    });
  }, []);

  const save = useCallback((now = false) => {
    const ex = excalidraw;
    if (!ex) return;
    clearTimeout(saveTimer.current);
    const run = () => {
      const elements = ex.getSceneElements();
      uploadFiles(elements, ex.getFiles());
      const hash = saveHash(elements);
      if (hash === lastSaved.current) return;
      lastSaved.current = hash;
      api
        .saveScene({ elements: [...elements], appState: { viewBackgroundColor: ex.getAppState().viewBackgroundColor } })
        .catch((err: unknown) => {
          lastSaved.current = "";
          console.error("excaliagent: save failed", err);
        });
    };
    if (now) run();
    else saveTimer.current = setTimeout(run, SAVE_DEBOUNCE_MS);
  }, [excalidraw, uploadFiles]);

  /** Bring the scene in line with what we know about sessions. */
  const sync = useCallback(
    (add?: Session[]) => {
      const ex = excalidraw;
      if (!ex) return;
      const elements = ex.getSceneElementsIncludingDeleted();

      const missing = idsToLookup(cardSessionIds(elements), live.current, known.current, asked.current);
      if (missing.length) {
        for (const id of missing) asked.current.add(id);
        api
          .lookup(missing)
          .then((found) => {
            for (const s of found) known.current.set(s.id, s);
            if (found.length) sync();
          })
          .catch(() => {
            for (const id of missing) asked.current.delete(id);
          });
      }

      for (const s of add ?? []) known.current.set(s.id, s);
      const result = reconcile(mergeSessions(live.current, known.current), elements, Date.now(), defaultGen, {
        add,
        measure,
      });
      if (!result.changed) return;
      ex.updateScene({ elements: result.elements, captureUpdate: CaptureUpdateAction.NEVER });
      save(true);
    },
    [excalidraw, save],
  );

  useEffect(() => {
    if (excalidraw) void fontsReady().then(() => setFontsLoaded(true));
  }, [excalidraw]);

  // Live session stream + periodic refresh of ages and cache warmth.
  useEffect(() => {
    if (!excalidraw || !fontsLoaded) return;
    const unsubscribe = api.subscribe(
      (sessions) => {
        live.current = sessions;
        // A session that came back to life must be re-fetched once it goes dormant again.
        for (const s of sessions) {
          known.current.delete(s.id);
          asked.current.delete(s.id);
        }
        sync();
      },
      setConnected,
    );
    // A font face that loads later (e.g. a new script) changes measurements: re-fit.
    const onFonts = () => sync();
    document.fonts.addEventListener("loadingdone", onFonts);
    let ticks = 0;
    const timer = setInterval(() => {
      if (++ticks % 10 === 0) asked.current.clear();
      sync();
    }, TICK_MS);
    (window as unknown as { __excaliagent: unknown }).__excaliagent = { excalidraw, sync };
    return () => {
      unsubscribe();
      clearInterval(timer);
      document.fonts.removeEventListener("loadingdone", onFonts);
    };
  }, [excalidraw, fontsLoaded, sync]);

  const onChange = useCallback(
    (elements: Elements, _appState: AppState, files: BinaryFiles) => {
      uploadFiles(elements, files);
      // "Reset the canvas" (main menu): lay out a fresh board right away, not on the next tick.
      if (!elements.some((e) => !e.isDeleted)) sync();
      if (saveHash(elements.filter((e) => !e.isDeleted)) !== lastSaved.current) save();
    },
    [save, sync, uploadFiles],
  );

  const sessionFor = useCallback(
    (sessionId: string) => mergeSessions(live.current, known.current).find((s) => s.id === sessionId),
    [],
  );

  // Double-click a card: focus its pane, or resume it. Right-click: our menu section.
  // Capture phase so Excalidraw does not also enter text editing.
  const wrapper = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = wrapper.current;
    if (!el || !excalidraw) return;
    const targetUnder = (event: MouseEvent): MenuTarget | undefined => {
      if (!(event.target instanceof HTMLCanvasElement)) return undefined;
      const appState = excalidraw.getAppState() as AppState;
      if (appState.activeTool.type !== "selection") return undefined;
      const { x, y } = viewportCoordsToSceneCoords({ clientX: event.clientX, clientY: event.clientY }, appState);
      const elements = excalidraw.getSceneElements();
      const sessionId = cardAt(elements, x, y);
      if (sessionId) return { kind: "card", sessionId };
      const lane = laneTargetAt(elements, x, y);
      return lane ? { kind: "lane", laneId: lane.id } : undefined;
    };
    const onDblClick = (event: MouseEvent) => {
      const target = targetUnder(event);
      if (target?.kind !== "card") return;
      event.stopPropagation();
      event.preventDefault();
      void openSession(excalidraw, target.sessionId, sessionFor(target.sessionId));
    };
    // Do not preventDefault: Excalidraw still opens its own menu; ours glues onto it.
    const onContextMenu = (event: MouseEvent) => setMenuFor(targetUnder(event) ?? null);
    el.addEventListener("dblclick", onDblClick, true);
    el.addEventListener("contextmenu", onContextMenu, true);
    return () => {
      el.removeEventListener("dblclick", onDblClick, true);
      el.removeEventListener("contextmenu", onContextMenu, true);
    };
  }, [excalidraw, sessionFor]);

  /** Main menu → "Add starter lanes": a normal, undoable edit. */
  const addLanes = useCallback(() => {
    const ex = excalidraw;
    if (!ex) return;
    const next = appendLanes(ex.getSceneElementsIncludingDeleted(), defaultGen, Date.now(), measure);
    if (!next) {
      ex.setToast({ message: "No inbox on the board to put lanes beside.", duration: 3000, closable: true });
      return;
    }
    ex.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    save(true);
  }, [excalidraw, save]);

  /** "+ Lane": one more lane at the right end, as an undoable edit, scrolled into view. */
  const addOneLane = useCallback(() => {
    const ex = excalidraw;
    if (!ex) return;
    const { elements, lane } = addLane(ex.getSceneElementsIncludingDeleted(), defaultGen, Date.now(), measure);
    ex.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    ex.scrollToContent(lane, { animate: true });
    save(true);
  }, [excalidraw, save]);

  /**
   * Move cards in direct response to a user gesture (a drop on a lane title,
   * "Tidy cards"): one undoable edit, unlike reconcile's patches.
   */
  const placeCards = useCallback(
    (moves: ReadonlyMap<string, { x: number; y: number }>) => {
      const ex = excalidraw;
      if (!ex || !moves.size) return;
      const elements = moveCards(ex.getSceneElementsIncludingDeleted(), moves, defaultGen, Date.now());
      ex.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      save(true);
    },
    [excalidraw, save],
  );

  const tidyLane = useCallback(
    (laneId: string) => {
      const ex = excalidraw;
      const lane = ex?.getSceneElements().find((e) => e.id === laneId);
      if (ex && lane) placeCards(tidyMoves(ex.getSceneElements(), lane));
    },
    [excalidraw, placeCards],
  );

  /** "Tidy all" (top right and main menu): every lane and the inbox at once, one undoable edit. */
  const tidyAll = useCallback(() => {
    const ex = excalidraw;
    if (!ex) return;
    const moves = tidyAllMoves(ex.getSceneElements());
    if (!moves.size) ex.setToast({ message: "Every card is already tidy.", duration: 2000, closable: true });
    placeCards(moves);
  }, [excalidraw, placeCards]);

  // Drag a lone card over a lane's title band: the band lights up and an outline
  // shows where the card will land; dropping it there puts it in the lane's
  // column, below the lowest card. Alt (Excalidraw's duplicate-drag) opts out.
  const dropTarget = useRef<DropHint | null>(null);
  useEffect(() => {
    const ex = excalidraw;
    if (!ex || !laneDrop) return;
    /** The card being dragged and the lanes, taken once when its drag starts. */
    let drag: { cardId: string; lanes: ExcalidrawElement[] } | null = null;
    // Pointer moves are frequent: re-render (and so re-render <Excalidraw>) only
    // when the visible bands, the hovered zone or the target slot actually change.
    const show = (hint: DropHint | null) => {
      const prev = dropTarget.current;
      if (hintKey(prev) === hintKey(hint)) return;
      dropTarget.current = hint;
      setDropHint(hint);
    };
    const stop = () => {
      drag = null;
      show(null);
    };
    const onMove = (event: PointerEvent) => {
      const appState = ex.getAppState() as AppState;
      if (!(event.buttons & 1) || event.altKey || !appState.selectedElementsAreBeingDragged) return stop();
      const elements = ex.getSceneElements();
      const card = draggedCard(elements, appState.selectedElementIds);
      if (!card) return stop();
      if (drag?.cardId !== card.id) drag = { cardId: card.id, lanes: lanesOf(elements) };
      const zoom = appState.zoom.value;
      const view = { x: -appState.scrollX, y: -appState.scrollY, width: appState.width / zoom, height: appState.height / zoom };
      const bands = zonesInView(drag.lanes, view).map(({ laneId, zone }) => ({ laneId, box: toViewport(zone, appState) }));
      const { x, y } = viewportCoordsToSceneCoords({ clientX: event.clientX, clientY: event.clientY }, appState);
      const lane = dropLaneAt(drag.lanes, x, y);
      const slot = lane && slotBelow(elements, lane, card.id);
      show({
        bands,
        hover:
          lane && slot
            ? {
                laneId: lane.id,
                cardId: card.id,
                zone: toViewport(dropZone(lane), appState),
                slot: toViewport({ ...slot, width: card.width, height: card.height }, appState),
              }
            : null,
      });
    };
    // Excalidraw calls this from inside its own pointerup handler; place the card
    // once that has finished committing the drag.
    const offUp = ex.onPointerUp((_tool, _state, event) => {
      const hint = dropTarget.current?.hover;
      stop();
      if (!hint || event.altKey) return;
      setTimeout(() => {
        const elements = ex.getSceneElements();
        const lane = elements.find((e) => e.id === hint.laneId);
        if (!lane || !elements.some((e) => e.id === hint.cardId)) return;
        placeCards(new Map([[hint.cardId, slotBelow(elements, lane, hint.cardId)]]));
      }, 0);
    });
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      offUp();
      stop();
    };
  }, [excalidraw, laneDrop, placeCards]);

  const toggleLaneDrop = useCallback(() => {
    setLaneDrop((on) => {
      writeLaneDrop(!on, settingsStore());
      return !on;
    });
  }, []);

  const closeMenu = useCallback(() => setMenuFor(null), []);
  const onMenuAction = useCallback(
    (item: MenuItem) => {
      const ex = excalidraw;
      const target = menuFor;
      setMenuFor(null);
      if (!ex || !target) return;
      if (target.kind === "lane") {
        if (item.action === "tidy") tidyLane(target.laneId);
        return;
      }
      const { sessionId } = target;
      switch (item.action) {
        case "focus":
          void focusSession(ex, sessionId);
          break;
        case "resume":
          void resumeSession(ex, sessionId, sessionFor(sessionId));
          break;
        case "copy":
          void copyText(ex, item.text, `Copied: ${item.text}`);
          break;
        case "open":
          window.open(item.url, "_blank", "noopener,noreferrer");
          break;
        case "end":
          void endSession(ex, sessionId, sessionFor(sessionId));
          break;
      }
    },
    [excalidraw, menuFor, sessionFor, tidyLane],
  );
  const excaliHost = menuFor || dropHint ? wrapper.current?.querySelector<HTMLElement>(".excalidraw") : null;
  const menuHost = menuFor ? excaliHost : null;

  const refreshPicker = useCallback(() => {
    api
      .picker()
      .then(setPickerRows)
      .catch(() => setPickerRows([]));
  }, []);

  const addFromPicker = useCallback(
    (s: Session) => {
      sync([s]);
      setPickerRows((rows) => rows?.filter((r) => r.id !== s.id) ?? null);
    },
    [sync],
  );

  if (!initialData) return <div style={{ padding: 16, fontFamily: "sans-serif" }}>Loading board…</div>;

  const carded = excalidraw ? cardSessionIds(excalidraw.getSceneElements()) : new Set<string>();
  return (
    <div ref={wrapper} style={{ height: "100%" }}>
      <Excalidraw
        initialData={initialData}
        excalidrawAPI={setExcalidraw}
        onChange={onChange}
        renderTopRightUI={(isMobile, appState) => (
          <TopBar layout={topBarLayout(appState.width, isMobile, 3)}>
            {!connected && <span className="excaliagent-offline">server offline</span>}
            <TopButton
              icon={PlusIcon}
              label="Lane"
              name="Add lane"
              title="Add a lane at the right end"
              onClick={addOneLane}
            />
            <TopButton
              icon={TidyIcon}
              label="Tidy all"
              name="Tidy all"
              title="Stack the cards of every lane and the inbox (one undo step)"
              onClick={tidyAll}
            />
            <Sidebar.Trigger
              name={PICKER}
              icon={SessionsIcon}
              title="Add a dormant session to the board"
              onToggle={(open) => open && refreshPicker()}
            >
              Sessions
            </Sidebar.Trigger>
          </TopBar>
        )}
      >
        <MainMenu>
          <MainMenu.Item onSelect={addLanes}>Add starter lanes</MainMenu.Item>
          <MainMenu.Item onSelect={tidyAll} title="Stack the cards of every lane and the inbox (one undo step)">
            Tidy all
          </MainMenu.Item>
          <MainMenu.Item
            onSelect={toggleLaneDrop}
            icon={checkbox(laneDrop)}
            role="menuitemcheckbox"
            aria-checked={laneDrop}
            title="Drop a card on a lane's title to stack it below the lane's cards"
          >
            Drop on lane title stacks cards
          </MainMenu.Item>
          <MainMenu.Separator />
          <MainMenu.DefaultItems.LoadScene />
          <MainMenu.DefaultItems.SaveToActiveFile />
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.Group title="Excalidraw links">
            <MainMenu.DefaultItems.Socials />
          </MainMenu.Group>
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
        <Sidebar name={PICKER}>
          <Sidebar.Header>Dormant sessions</Sidebar.Header>
          <div style={{ overflowY: "auto", padding: "0 12px 12px" }}>
            {pickerRows === null && <p>Loading…</p>}
            {pickerRows?.length === 0 && <p>Nothing here. Every session is on the board.</p>}
            {pickerRows
              ?.filter((s) => !carded.has(s.id))
              .map((s) => (
                <div key={s.id} className="excaliagent-picker-row" style={rowStyle}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={ellipsis} title={s.title ?? s.id}>
                      <strong>{s.title ?? s.name ?? s.id.slice(0, 8)}</strong>
                    </div>
                    <div style={{ ...ellipsis, fontSize: 12, opacity: 0.7 }}>
                      {s.repo}
                      {s.branch ? ` · ${s.branch}` : ""} · {formatAge(Date.now() - s.lastActivityAt)}
                    </div>
                  </div>
                  <button type="button" onClick={() => addFromPicker(s)}>
                    Add
                  </button>
                </div>
              ))}
          </div>
        </Sidebar>
      </Excalidraw>
      {menuFor && menuHost && (
        <CardMenu
          host={menuHost}
          items={menuFor.kind === "card" ? menuItems(menuFor.sessionId, sessionFor(menuFor.sessionId)) : laneMenuItems()}
          onAction={onMenuAction}
          onClose={closeMenu}
        />
      )}
      {dropHint && excaliHost && <LaneDropHint hint={dropHint} host={excaliHost} />}
    </div>
  );
}

/** A square checkbox icon for a main-menu toggle, in Excalidraw's 20 px icon style. */
function checkbox(on: boolean) {
  return (
    <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.25" aria-hidden="true">
      <rect x="3.5" y="3.5" width="13" height="13" rx="2.5" />
      {on && <path d="M6.5 10.2l2.4 2.4 4.6-5" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />}
    </svg>
  );
}

/** Identity of a drop hint, rounded to whole px, so sub-pixel jitter does not re-render. */
function hintKey(h: DropHint | null): string {
  if (!h) return "";
  const r = (b: ViewBox) => [b.left, b.top, b.width, b.height].map(Math.round).join(",");
  const bands = h.bands.map((b) => `${b.laneId}:${r(b.box)}`).join(";");
  const hover = h.hover ? `${h.hover.laneId}|${h.hover.cardId}|${r(h.hover.zone)}|${r(h.hover.slot)}` : "";
  return `${bands}#${hover}`;
}

/**
 * Not scene elements: a temporary overlay (pointer-events: none) shown while a
 * card is dragged. Every visible lane's title band gets a faint dashed hint
 * with a "drop to stack" caption, so the drop zones can be found; the band
 * under the pointer gets the strong highlight plus a dashed outline where the
 * card will land. Portalled into the `.excalidraw` root (like CardMenu) so it
 * uses the theme's colours in light and dark mode.
 */
function LaneDropHint({ hint, host }: { hint: DropHint; host: HTMLElement }) {
  const box = (b: ViewBox) => ({ position: "fixed", left: b.left, top: b.top, width: b.width, height: b.height }) as const;
  const { hover } = hint;
  return createPortal(
    <div className="excaliagent-lane-drop" aria-hidden="true" style={{ pointerEvents: "none", position: "fixed", inset: 0, zIndex: 2 }}>
      {hint.bands
        .filter((b) => b.laneId !== hover?.laneId)
        .map((b) => (
          <div
            key={b.laneId}
            className="excaliagent-lane-hint"
            style={{
              ...box(b.box),
              boxSizing: "border-box",
              borderRadius: 8,
              border: "1.5px dashed color-mix(in srgb, var(--color-primary) 55%, transparent)",
              background: "color-mix(in srgb, var(--color-primary) 7%, transparent)",
            }}
          >
            <span
              style={{
                position: "absolute",
                right: 6,
                bottom: "100%",
                marginBottom: 2,
                fontSize: 11,
                lineHeight: 1.2,
                whiteSpace: "nowrap",
                fontFamily: "var(--ui-font, sans-serif)",
                color: "var(--color-primary)",
                opacity: 0.85,
              }}
            >
              drop to stack ↓
            </span>
          </div>
        ))}
      {hover && (
        <>
          <div
            className="excaliagent-lane-drop-zone"
            style={{
              ...box(hover.zone),
              boxSizing: "border-box",
              borderRadius: 8,
              border: "2px solid var(--color-primary)",
              background: "color-mix(in srgb, var(--color-primary) 22%, transparent)",
              boxShadow: "0 0 0 4px color-mix(in srgb, var(--color-primary) 14%, transparent)",
            }}
          />
          <div
            className="excaliagent-lane-drop-slot"
            style={{
              ...box(hover.slot),
              boxSizing: "border-box",
              borderRadius: 8,
              border: "2px dashed var(--color-primary)",
              background: "color-mix(in srgb, var(--color-primary) 8%, transparent)",
            }}
          />
        </>
      )}
    </div>,
    host,
  );
}

async function openSession(ex: ExcalidrawImperativeAPI, sessionId: string, session: Session | undefined) {
  if (session?.live) return focusSession(ex, sessionId);
  if (session) return resumeSession(ex, sessionId, session);
}

async function focusSession(ex: ExcalidrawImperativeAPI, sessionId: string) {
  try {
    if (await api.focus(sessionId)) return;
  } catch (err) {
    console.error("excaliagent: focus failed", err);
  }
  ex.setToast({
    message: "Running, but not in a herdr pane I can find. Right-click → Stop session, then double-click resumes it in herdr.",
    duration: 6000,
    closable: true,
  });
}

/** Right-click → Stop session: confirm, then the server ends it (SIGTERM; the conversation is kept). */
async function endSession(ex: ExcalidrawImperativeAPI, sessionId: string, session: Session | undefined) {
  const name = session?.title || session?.name || session?.repo || "this session";
  const ok = window.confirm(
    `Stop "${name}"?\n\nClaude Code exits as if its terminal was closed; work in progress is interrupted. The conversation is kept, and double-clicking the card resumes it.`,
  );
  if (!ok) return;
  let ended: boolean;
  try {
    ended = await api.end(sessionId);
  } catch (err) {
    console.error("excaliagent: stop failed", err);
    ex.setToast({ message: "Could not stop the session.", duration: 4000, closable: true });
    return;
  }
  ex.setToast({ message: ended ? `Stopped "${name}".` : "It is not running any more.", duration: 3000, closable: true });
}

/** Resume in a new herdr tab; without herdr, hand over the shell command instead. */
async function resumeSession(ex: ExcalidrawImperativeAPI, sessionId: string, session: Session | undefined) {
  let result: Awaited<ReturnType<typeof api.resume>> | "error";
  try {
    result = await api.resume(sessionId);
  } catch (err) {
    console.error("excaliagent: resume failed", err);
    result = "error";
  }
  if (result === "ok") {
    ex.setToast({ message: "Resuming in a new herdr tab…", duration: 3000, closable: true });
    return;
  }
  if (result === "live") return focusSession(ex, sessionId);
  const command = session ? resumeCommand(session) : `claude --resume ${sessionId}`;
  const why = result === "no herdr" ? "herdr not running" : "Could not resume";
  await copyText(ex, command, `${why}. Copied: ${command}`, `${why}. Resume with: ${command}`);
}

async function copyText(ex: ExcalidrawImperativeAPI, text: string, copied: string, fallback = `Copy failed: ${text}`) {
  try {
    await navigator.clipboard.writeText(text);
    ex.setToast({ message: copied, duration: 4000, closable: true });
  } catch {
    ex.setToast({ message: fallback, duration: 8000, closable: true });
  }
}

const rowStyle = {
  display: "flex",
  gap: 8,
  alignItems: "center",
  padding: "8px 0",
  borderBottom: "1px solid var(--default-border-color, #ddd)",
} as const;
const ellipsis = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } as const;
