import type { Pane } from "../../shared/types.ts";

export type { Pane };

export interface ResumeRequest {
  cwd: string;
  repoRoot?: string;
  /** Typed into the new shell followed by a newline. Built server-side only. */
  command: string;
  label: string;
}

/** A terminal multiplexer that can show where a session runs. */
export interface PaneLink {
  available(): boolean;
  /** Pane whose foreground process tree contains pid, if any. */
  match(pid: number): Pane | undefined;
  focus(paneId: string): Promise<void>;
  /** Called whenever the pid → pane map changes. Returns an unsubscribe. */
  onChange(cb: () => void): () => void;
  /**
   * Open a new terminal (tab in the workspace already showing repoRoot ?? cwd,
   * else a new workspace) in cwd, type `command`, and bring it to the front.
   * Optional: only multiplexers that can do it implement it.
   */
  resume?(req: ResumeRequest): Promise<{ paneId: string }>;
  /** Re-match pids now (e.g. the session registry changed). Optional. */
  refresh?(): Promise<void>;
  close(): void;
}
