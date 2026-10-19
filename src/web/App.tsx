import { useCallback, useEffect, useRef, useState } from "react";
import {
  CaptureUpdateAction,
  Excalidraw,
  Sidebar,
  restoreElements,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { AppState, ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import type { Session } from "../shared/types.ts";
import { api } from "./api.ts";
import { cardAt, cardSessionIds, idsToLookup, mergeSessions, resumeCommand, saveHash } from "./board.ts";
import { defaultGen, formatAge } from "./cards.ts";
import { reconcile } from "./reconcile.ts";

// Serve Excalidraw's fonts from our own server, never a CDN.
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = "/";

const PICKER = "excaliagent-picker";
const SAVE_DEBOUNCE_MS = 500;
const TICK_MS = 30_000;

type Elements = readonly ExcalidrawElement[];

export function App() {
  const [initialData, setInitialData] = useState<ExcalidrawInitialDataState | null>(null);
  const [excalidraw, setExcalidraw] = useState<ExcalidrawImperativeAPI | null>(null);
  const [connected, setConnected] = useState(true);
  const [pickerRows, setPickerRows] = useState<Session[] | null>(null);

  const live = useRef<Session[]>([]);
  const known = useRef(new Map<string, Session>());
  const asked = useRef(new Set<string>());
  const lastSaved = useRef("");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    api
      .loadScene()
      .then((scene) => {
        const elements = restoreElements(scene.elements as ExcalidrawElement[], null);
        lastSaved.current = saveHash(elements.filter((e) => !e.isDeleted));
        const bg = scene.appState.viewBackgroundColor;
        setInitialData({
          elements,
          appState: typeof bg === "string" ? { viewBackgroundColor: bg } : {},
          scrollToContent: true,
        });
      })
      .catch((err: unknown) => {
        console.error("excaliagent: could not load scene", err);
        setInitialData({ elements: [] });
      });
  }, []);

  const save = useCallback((now = false) => {
    const ex = excalidraw;
    if (!ex) return;
    clearTimeout(saveTimer.current);
    const run = () => {
      const elements = ex.getSceneElements();
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
  }, [excalidraw]);

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
      const result = reconcile(mergeSessions(live.current, known.current), elements, Date.now(), defaultGen, { add });
      if (!result.changed) return;
      ex.updateScene({ elements: result.elements, captureUpdate: CaptureUpdateAction.NEVER });
      save(true);
    },
    [excalidraw, save],
  );

  // Live session stream + periodic refresh of ages and cache warmth.
  useEffect(() => {
    if (!excalidraw) return;
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
    let ticks = 0;
    const timer = setInterval(() => {
      if (++ticks % 10 === 0) asked.current.clear();
      sync();
    }, TICK_MS);
    (window as unknown as { __excaliagent: unknown }).__excaliagent = { excalidraw, sync };
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [excalidraw, sync]);

  const onChange = useCallback(
    (elements: Elements) => {
      if (saveHash(elements.filter((e) => !e.isDeleted)) !== lastSaved.current) save();
    },
    [save],
  );

  // Double-click a card: focus its pane, or copy the resume command.
  // Capture phase so Excalidraw does not also enter text editing.
  const wrapper = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = wrapper.current;
    if (!el || !excalidraw) return;
    const onDblClick = (event: MouseEvent) => {
      if (!(event.target instanceof HTMLCanvasElement)) return;
      const appState = excalidraw.getAppState() as AppState;
      if (appState.activeTool.type !== "selection") return;
      const { x, y } = viewportCoordsToSceneCoords({ clientX: event.clientX, clientY: event.clientY }, appState);
      const sessionId = cardAt(excalidraw.getSceneElements(), x, y);
      if (!sessionId) return;
      event.stopPropagation();
      event.preventDefault();
      const session = mergeSessions(live.current, known.current).find((s) => s.id === sessionId);
      void openSession(excalidraw, sessionId, session);
    };
    el.addEventListener("dblclick", onDblClick, true);
    return () => el.removeEventListener("dblclick", onDblClick, true);
  }, [excalidraw]);

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
    </div>
  );
}

async function openSession(ex: ExcalidrawImperativeAPI, sessionId: string, session: Session | undefined) {
  if (session?.live) {
    try {
      if (await api.focus(sessionId)) return;
    } catch (err) {
      console.error("excaliagent: focus failed", err);
    }
    ex.setToast({ message: "Running, but not in a herdr pane I can find.", duration: 3000, closable: true });
    return;
  }
  if (!session) return;
  const command = resumeCommand(session);
  try {
    await navigator.clipboard.writeText(command);
    ex.setToast({ message: `No pane. Copied: ${command}`, duration: 4000, closable: true });
  } catch {
    ex.setToast({ message: `No pane. Resume with: ${command}`, duration: 8000, closable: true });
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
