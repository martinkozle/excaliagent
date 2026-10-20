// Several harness adapters behind one Source. Session ids are not qualified by
// harness: Claude uses random UUIDs (v4) and Codex time-ordered UUIDs (v7), so
// they cannot collide, and boards saved before multi-harness support keep
// their cards. Each source rejects ids that are not its own format, so `get`
// and `end` simply ask them in order.
import type { Session } from "../../shared/types.ts";
import type { Source } from "./types.ts";

const byId = (a: Session, b: Session) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Fail soft: one broken adapter must not take the others down. */
async function settle<T>(work: Promise<T[]>, warn: (m: string) => void, what: string): Promise<T[]> {
  try {
    return await work;
  } catch (e) {
    warn(`excaliagent: ${what} failed: ${(e as Error).message}`);
    return [];
  }
}

export function combineSources(sources: Source[], warn: (m: string) => void = console.warn): Source {
  if (sources.length === 1) return sources[0]!;
  return {
    async list() {
      const lists = await Promise.all(sources.map((s) => settle(s.list(), warn, "listing sessions")));
      return lists.flat().sort(byId);
    },

    watch(cb) {
      const latest: (Session[] | undefined)[] = sources.map(() => undefined);
      const emit = () => cb(latest.flatMap((l) => l ?? []).sort(byId));
      const offs = sources.map((s, i) =>
        s.watch((sessions) => {
          latest[i] = sessions;
          emit();
        }),
      );
      return () => {
        for (const off of offs) off();
      };
    },

    async listDormant() {
      const lists = await Promise.all(sources.map((s) => settle(s.listDormant(), warn, "listing dormant sessions")));
      return lists.flat().sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    },

    async get(id) {
      for (const s of sources) {
        const found = await s.get(id).catch(() => undefined);
        if (found) return found;
      }
      return undefined;
    },

    async end(id) {
      for (const s of sources) {
        const found = await s.get(id).catch(() => undefined);
        if (found) return s.end ? s.end(id) : "unsupported";
      }
      return "not-live";
    },
  };
}
