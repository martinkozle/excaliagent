import { useCallback, useEffect, useRef, useState } from "react";
import {
  CaptureUpdateAction,
  Excalidraw,
  MainMenu,
  Sidebar,
  restoreElements,
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
  menuItems,
  mergeSessions,
  resumeCommand,
  saveHash,
  type MenuItem,
} from "./board.ts";
import { CardMenu } from "./CardMenu.tsx";
import { defaultGen, formatAge } from "./cards.ts";
import { canvasMeasure } from "./measure.ts";
import { reconcile } from "./reconcile.ts";
import { LOGOS, logoFiles } from "./logos.ts";
import { addLane, appendLanes } from "./lanes.ts";

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

export function App() {
  const [initialData, setInitialData] = useState<ExcalidrawInitialDataState | null>(null);
  const [excalidraw, setExcalidraw] = useState<ExcalidrawImperativeAPI | null>(null);
  const [connected, setConnected] = useState(true);
  const [pickerRows, setPickerRows] = useState<Session[] | null>(null);
  const [fontsLoaded, setFontsLoaded] = useState(false);
  /** Card whose right-click menu is open. */
  const [menuFor, setMenuFor] = useState<string | null>(null);

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
    const cardUnder = (event: MouseEvent): string | undefined => {
      if (!(event.target instanceof HTMLCanvasElement)) return undefined;
      const appState = excalidraw.getAppState() as AppState;
      if (appState.activeTool.type !== "selection") return undefined;
      const { x, y } = viewportCoordsToSceneCoords({ clientX: event.clientX, clientY: event.clientY }, appState);
      return cardAt(excalidraw.getSceneElements(), x, y);
    };
    const onDblClick = (event: MouseEvent) => {
      const sessionId = cardUnder(event);
      if (!sessionId) return;
      event.stopPropagation();
      event.preventDefault();
      void openSession(excalidraw, sessionId, sessionFor(sessionId));
    };
    // Do not preventDefault: Excalidraw still opens its own menu; ours glues onto it.
    const onContextMenu = (event: MouseEvent) => setMenuFor(cardUnder(event) ?? null);
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

  const closeMenu = useCallback(() => setMenuFor(null), []);
  const onMenuAction = useCallback(
    (item: MenuItem) => {
      const ex = excalidraw;
      const sessionId = menuFor;
      setMenuFor(null);
      if (!ex || !sessionId) return;
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
      }
    },
    [excalidraw, menuFor, sessionFor],
  );
  const menuHost = menuFor ? wrapper.current?.querySelector<HTMLElement>(".excalidraw") : null;

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
        renderTopRightUI={() => (
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {!connected && <span style={{ color: "#e03131", fontSize: 12 }}>server offline</span>}
            <button type="button" className="sidebar-trigger" title="Add a lane at the right end" onClick={addOneLane}>
              + Lane
            </button>
            <Sidebar.Trigger
              name={PICKER}
              title="Add a dormant session to the board"
              onToggle={(open) => open && refreshPicker()}
            >
              Sessions
            </Sidebar.Trigger>
          </div>
        )}
      >
        <MainMenu>
          <MainMenu.Item onSelect={addLanes}>Add starter lanes</MainMenu.Item>
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
        <CardMenu host={menuHost} items={menuItems(menuFor, sessionFor(menuFor))} onAction={onMenuAction} onClose={closeMenu} />
      )}
    </div>
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
  ex.setToast({ message: "Running, but not in a herdr pane I can find.", duration: 3000, closable: true });
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
