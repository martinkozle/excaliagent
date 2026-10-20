// Our own character UI (not Excalidraw elements), styled like Excalidraw's
// library: the "Change character…" picker and the Characters sidebar panel.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { PACK_NAME, validEmoji, type CharactersData, type Pack, type PackCharacter } from "../shared/packs.ts";
import { api } from "./api.ts";
import "./characters.css";

const IMAGE_TYPES = "image/png,image/gif,image/webp,image/jpeg,image/svg+xml";

function CharacterFace({ c }: { c: PackCharacter }) {
  // An image that does not load shows a quiet placeholder, not a broken image.
  const [broken, setBroken] = useState(false);
  if (c.kind === "emoji") return <span className="emoji">{c.id}</span>;
  if (broken) return <span className="emoji" title={`${c.id} could not be loaded`}>❔</span>;
  return <img src={c.url} alt={c.id} draggable={false} onError={() => setBroken(true)} />;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Right-click → "Change character…": every pack's characters, Shuffle, Reset to automatic. */
export function CharacterPicker({
  host,
  data,
  currentFileId,
  hasOverride,
  onPick,
  onNone,
  onShuffle,
  onReset,
  onClose,
}: {
  host: HTMLElement;
  data: CharactersData;
  currentFileId: string | undefined;
  hasOverride: boolean;
  onPick: (pack: string, id: string) => void;
  onNone: () => void;
  onShuffle: () => void;
  onReset: () => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  // Focus moves into the dialog (the current character), Tab stays inside, Esc closes it.
  useEffect(() => {
    const el = dialog.current;
    const back = document.activeElement as HTMLElement | null;
    const focusIn = () => {
      if (!el || el.contains(document.activeElement)) return;
      (el.querySelector<HTMLElement>('.excaliagent-char[aria-pressed="true"]') ?? el.querySelector<HTMLElement>(FOCUSABLE))?.focus();
    };
    focusIn();
    // The right-click menu's pointer events finish after we open; Excalidraw may take focus back once.
    const retry = setTimeout(focusIn, 120);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !el) return;
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const inside = el.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      clearTimeout(retry);
      back?.focus?.();
    };
  }, [onClose]);

  const packs = [...data.packs].sort((a, b) => Number(b.id === data.activePack) - Number(a.id === data.activePack));
  return createPortal(
    <div className="excaliagent-picker-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={dialog} className="excaliagent-picker" role="dialog" aria-modal="true" aria-label="Change character">
        <header>
          <h2>Change character</h2>
          <button type="button" className="excaliagent-btn" onClick={onShuffle} title="A random character from the active pack">
            Shuffle
          </button>
          <button type="button" className="excaliagent-btn" onClick={onReset} disabled={!hasOverride && currentFileId !== undefined}>
            Reset to automatic
          </button>
          <button
            type="button"
            className="excaliagent-btn"
            onClick={onNone}
            aria-pressed={currentFileId === undefined}
            title="No character on this card (pick one to bring it back)"
          >
            None
          </button>
          <button type="button" className="excaliagent-btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="body excaliagent-chars" style={{ padding: "8px 16px 16px" }}>
          {packs.map((p) => (
            <section key={p.id}>
              <h3>
                {p.name}
                {p.id === data.activePack ? " (active)" : ""}
              </h3>
              {p.characters.length === 0 && <p className="excaliagent-note">Empty.</p>}
              <div className="excaliagent-char-grid" style={{ marginTop: 6 }}>
                {p.characters.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="excaliagent-char"
                    title={c.kind === "image" ? c.id : undefined}
                    aria-label={`${p.name}: ${c.id}`}
                    aria-pressed={c.fileId === currentFileId}
                    onClick={() => onPick(p.id, c.id)}
                  >
                    <CharacterFace c={c} />
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>,
    host,
  );
}

function readAsDataURL(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** The Characters sidebar: choose the active pack, make and edit custom packs. */
export function CharactersPanel({
  data,
  request,
  onError,
}: {
  data: CharactersData | null;
  /** Run a character request; its answer is applied (unless a newer one was) and the board redrawn. */
  request: (fn: () => Promise<CharactersData>) => Promise<CharactersData | null>;
  onError: (message: string) => void;
}) {
  const [viewing, setViewing] = useState<string | null>(null);
  const [newPack, setNewPack] = useState("");
  const [emoji, setEmoji] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The pack just chosen, shown checked until the server confirms. */
  const [choosing, setChoosing] = useState<string | null>(null);

  if (!data) return <p style={{ padding: "0 12px" }}>Characters are not available (see the server log).</p>;
  /** The pack whose radio is checked: the one just chosen, until the server answers. */
  const active = choosing ?? data.activePack;
  const pack: Pack | undefined = data.packs.find((p) => p.id === (viewing ?? active)) ?? data.packs[0];

  const run = async (fn: () => Promise<CharactersData>, after?: () => void) => {
    setBusy(true);
    try {
      await request(fn);
      after?.();
    } catch (err) {
      onError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const upload = async (files: Iterable<File>) => {
    if (!pack || pack.builtIn) return;
    for (const f of files) {
      if (!IMAGE_TYPES.split(",").includes(f.type)) {
        onError(`${f.name}: only png, gif, webp, jpeg or svg images`);
        continue;
      }
      await run(async () => api.addImage(pack.id, f.name, await readAsDataURL(f)));
    }
  };

  const addEmoji = () => {
    const e = emoji.trim();
    if (!pack || !e) return;
    if (!validEmoji(e)) return onError("Type a single emoji.");
    void run(() => api.addEmoji(pack.id, e), () => setEmoji(""));
  };

  const create = (name: string, from?: string) => {
    if (!PACK_NAME.test(name)) {
      onError("Pack names: letters, digits, - and _ (up to 40), starting with a letter or digit.");
      return;
    }
    void run(() => api.createPack(name, from), () => setViewing(name));
  };

  const safeName = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^[-_]+/, "").slice(0, 40);

  let editor: ReactNode = null;
  if (pack && !pack.builtIn) {
    editor = (
      <>
        <div className="row">
          <input
            type="text"
            aria-label="Add an emoji"
            placeholder="Emoji or image"
            title="Type or paste an emoji, or paste an image"
            value={emoji}
            onChange={(e) => setEmoji(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addEmoji()}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (!files.length) return;
              e.preventDefault();
              void upload(files);
            }}
          />
          <button type="button" className="excaliagent-btn" onClick={addEmoji} disabled={busy}>
            Add
          </button>
        </div>
        <div
          className="excaliagent-drop"
          data-over={dragOver}
          onDragOver={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            // Keep Excalidraw from also dropping the image onto the canvas.
            e.preventDefault();
            e.stopPropagation();
            setDragOver(false);
            void upload(e.dataTransfer.files);
          }}
        >
          Drop images here, or{" "}
          <label style={{ color: "var(--color-primary)", cursor: "pointer", textDecoration: "underline" }}>
            upload
            <input
              type="file"
              accept={IMAGE_TYPES}
              multiple
              hidden
              aria-label="Upload images"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                void upload(files);
              }}
            />
          </label>
          <p className="excaliagent-note">png, gif, webp, jpeg or svg, up to 1 MB each</p>
        </div>
      </>
    );
  }

  return (
    <div className="excaliagent-chars" aria-busy={busy}>
      <h3>Packs</h3>
      <div role="radiogroup" aria-label="Active pack">
        {data.packs.map((p) => (
          // Clicking anywhere on a row shows that pack below. Its radio also makes
          // it active, and shows it too, so the radio and the preview never disagree
          // right after a choice.
          <div key={p.id} className="excaliagent-pack-row" data-viewing={p.id === pack?.id} onClick={() => setViewing(p.id)}>
            <input
              type="radio"
              name="excaliagent-active-pack"
              aria-label={`Use ${p.name}`}
              checked={p.id === active}
              onChange={() => {
                setViewing(p.id);
                setChoosing(p.id);
                void run(() => api.setActivePack(p.id)).finally(() => setChoosing(null));
              }}
            />
            {/* Showing a pack (to see or edit it) without making it active. */}
            <button
              type="button"
              className="name"
              aria-label={`Show ${p.name}`}
              aria-pressed={p.id === pack?.id}
              title={p.error ?? p.name}
              onClick={() => setViewing(p.id)}
            >
              {p.name}
              {p.error ? " ⚠" : ""}
            </button>
            <span className="count">{p.characters.length}</span>
          </div>
        ))}
      </div>
      {data.problems?.map((m) => (
        <p key={m} className="excaliagent-error">
          {m}
        </p>
      ))}
      <div className="row">
        <input
          type="text"
          aria-label="New pack name"
          placeholder="New pack name"
          value={newPack}
          onChange={(e) => setNewPack(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && create(newPack.trim())}
        />
        <button type="button" className="excaliagent-btn" disabled={busy || !newPack.trim()} onClick={() => create(newPack.trim())}>
          Create
        </button>
      </div>

      {pack && (
        <>
          <div className="row" style={{ marginTop: 4 }}>
            <h3 style={{ flex: 1, margin: 0 }}>{pack.name}</h3>
            {pack.builtIn ? (
              <button
                type="button"
                className="excaliagent-btn"
                disabled={busy}
                onClick={() => {
                  const name = window.prompt("Name for your copy:", safeName(`${pack.name}-copy`));
                  if (name) create(name.trim(), pack.id);
                }}
              >
                Duplicate to edit
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="excaliagent-btn"
                  disabled={busy}
                  onClick={() => {
                    const name = window.prompt("Rename pack:", pack.name);
                    if (name && name.trim() !== pack.id)
                      void run(() => api.renamePack(pack.id, name.trim()), () => setViewing(name.trim()));
                  }}
                >
                  Rename…
                </button>
                <button
                  type="button"
                  className="excaliagent-btn danger"
                  disabled={busy}
                  onClick={() => {
                    if (window.confirm(`Delete the pack "${pack.name}" and its images?`))
                      void run(() => api.deletePack(pack.id), () => setViewing(null));
                  }}
                >
                  Delete…
                </button>
              </>
            )}
          </div>
          {pack.builtIn && <p className="excaliagent-note">Built-in packs are read-only.</p>}
          {pack.error && <p className="excaliagent-error">{pack.error}</p>}
          {editor}
          {pack.characters.length === 0 && <p className="excaliagent-note">No characters yet.</p>}
          <div className="excaliagent-char-grid">
            {pack.characters.map((c) => (
              <div key={c.id} className="excaliagent-char" title={c.id} data-character={c.id}>
                <CharacterFace c={c} />
                {!pack.builtIn && (
                  <button
                    type="button"
                    className="remove"
                    aria-label={`Remove ${c.id}`}
                    disabled={busy}
                    onClick={() => void run(() => api.removeCharacter(pack.id, c.id))}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
          <p className="excaliagent-note">
            Custom packs live in the state directory under <code>packs/&lt;name&gt;/</code>: drop image files there, or
            list emoji in <code>pack.json</code> as <code>{'{"emoji": ["🧟"]}'}</code>.
          </p>
        </>
      )}
    </div>
  );
}
