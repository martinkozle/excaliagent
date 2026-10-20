import type { BinaryFileData } from "@excalidraw/excalidraw/types";
import type { Session } from "../shared/types.ts";

export type ResumeResult = "ok" | "no herdr" | "live" | "unknown";

export interface SavedScene {
  elements: unknown[];
  appState: Record<string, unknown>;
}

async function ok(res: Response): Promise<Response> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res;
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

export const api = {
  loadScene: async (): Promise<SavedScene> => (await ok(await fetch("/api/scene"))).json(),
  saveScene: async (scene: SavedScene): Promise<void> => {
    await ok(await fetch("/api/scene", jsonInit("PUT", scene)));
  },
  /** Image data of pasted pictures (Excalidraw keeps it apart from elements). */
  saveFiles: async (files: BinaryFileData[]): Promise<void> => {
    await ok(await fetch("/api/files", jsonInit("PUT", { files })));
  },
  loadFiles: async (ids: string[]): Promise<BinaryFileData[]> =>
    ids.length ? (await ok(await fetch("/api/files/get", jsonInit("POST", { ids })))).json() : [],
  sessions: async (): Promise<Session[]> => (await ok(await fetch("/api/sessions"))).json(),
  picker: async (): Promise<Session[]> => (await ok(await fetch("/api/picker"))).json(),
  lookup: async (ids: string[]): Promise<Session[]> =>
    ids.length ? (await ok(await fetch("/api/lookup", jsonInit("POST", { ids })))).json() : [],
  /** True if a pane got focus, false if the session has none. */
  focus: async (sessionId: string): Promise<boolean> => {
    const res = await fetch("/api/focus", jsonInit("POST", { sessionId }));
    if (res.status === 409) return false;
    await ok(res);
    return true;
  },
  /**
   * Resume a dormant session in a new herdr tab. "ok" on 204; otherwise why not:
   * "no herdr" / "live" (409), "unknown" (404). Other failures throw.
   */
  resume: async (sessionId: string): Promise<ResumeResult> => {
    const res = await fetch("/api/resume", jsonInit("POST", { sessionId }));
    if (res.status === 204) return "ok";
    if (res.status === 404) return "unknown";
    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      return body.error === "live" ? "live" : "no herdr";
    }
    await ok(res);
    return "ok";
  },
  /** Live session stream. EventSource reconnects by itself. */
  subscribe(onSessions: (s: Session[]) => void, onStatus?: (connected: boolean) => void): () => void {
    const es = new EventSource("/api/events");
    es.addEventListener("sessions", (e) => onSessions(JSON.parse((e as MessageEvent).data)));
    es.onopen = () => onStatus?.(true);
    es.onerror = () => onStatus?.(false);
    return () => es.close();
  },
};
