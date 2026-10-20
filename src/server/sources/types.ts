import type { Session } from "../../shared/types.ts";

export type { Session };

/** A harness adapter: where sessions come from. */
export interface Source {
  /** Live sessions (currently running), enriched from transcripts. */
  list(): Promise<Session[]>;
  /** Calls cb with the full live list whenever it changes. Returns an unsubscribe. */
  watch(cb: (sessions: Session[]) => void): () => void;
  /** Non-running sessions from the transcript store, newest first. */
  listDormant(): Promise<Session[]>;
  /** One session by id (live or dormant), or undefined. */
  get(id: string): Promise<Session | undefined>;
  /**
   * Ask a running session to exit, like closing its terminal (the conversation
   * is kept and can be resumed). "not-live" when it is not running (any more).
   */
  end?(id: string): Promise<"ended" | "not-live">;
}
