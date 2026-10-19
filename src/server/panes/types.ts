import type { Pane } from "../../shared/types.ts";

export type { Pane };

/** A terminal multiplexer that can show where a session runs. */
export interface PaneLink {
  available(): boolean;
  /** Pane whose foreground process tree contains pid, if any. */
  match(pid: number): Pane | undefined;
  focus(paneId: string): Promise<void>;
  /** Called whenever the pid → pane map changes. Returns an unsubscribe. */
  onChange(cb: () => void): () => void;
  /** Re-match pids now (e.g. the session registry changed). Optional. */
  refresh?(): Promise<void>;
  close(): void;
}
