// Our "excaliagent" section of the right-click menu on a card.
//
// Excalidraw 0.18 has no context-menu API, so we never touch its DOM. We render
// a separate panel, portalled into the `.excalidraw` root (to inherit its theme
// CSS variables), `position: fixed` and placed beside Excalidraw's own
// `.context-menu` (right if it fits, else left; top-aligned, clamped into the
// viewport — see `menuPlacement`). It follows that menu: when it
// disappears (MutationObserver), so do we. Items act on pointerdown, because
// Excalidraw closes its menu on any outside pointerdown; we let that event
// bubble on, which closes Excalidraw's menu, which in turn closes ours.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { estimatePanelHeight, menuPlacement, type MenuItem, type Placement } from "./board.ts";

const MENU_SELECTOR = ".popover .context-menu";
/** Give up if Excalidraw does not open its menu (e.g. right-click was swallowed). */
const APPEAR_TIMEOUT_MS = 1000;

export function CardMenu({
  host,
  items,
  onAction,
  onClose,
}: {
  host: HTMLElement;
  items: MenuItem[];
  onAction: (item: MenuItem) => void;
  onClose: () => void;
}) {
  const [placement, setPlacement] = useState<Placement | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const update = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    let seen = false;
    update.current = () => {
      const menu = host.querySelector<HTMLElement>(MENU_SELECTOR);
      if (!menu) {
        if (seen) onClose();
        return;
      }
      seen = true;
      const r = menu.getBoundingClientRect();
      const size = {
        width: Math.max(200, Math.round(r.width)),
        height: panel.current?.offsetHeight || estimatePanelHeight(items.length),
      };
      const next = menuPlacement(r, size, { width: window.innerWidth, height: window.innerHeight });
      setPlacement((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };
    const observer = new MutationObserver(() => update.current());
    observer.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
    update.current();
    const timeout = setTimeout(() => !seen && onClose(), APPEAR_TIMEOUT_MS);
    return () => {
      observer.disconnect();
      clearTimeout(timeout);
    };
  }, [host, items.length, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onScroll = () => onClose();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("wheel", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("wheel", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [onClose]);

  // Re-place once our real height is known.
  useLayoutEffect(() => {
    if (placement) update.current();
  }, [placement]);

  if (!placement) return null;
  return createPortal(
    <div
      ref={panel}
      className="excaliagent-menu"
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
      style={{
        position: "fixed",
        zIndex: 11,
        left: placement.left,
        width: placement.width,
        top: placement.top,
        boxSizing: "border-box",
        padding: "0.25rem 0 0.5rem",
        background: "var(--color-primary-light)",
        border: "1px solid var(--button-gray-3)",
        borderRadius: 4,
        boxShadow: "0 3px 10px rgba(0, 0, 0, 0.2)",
        userSelect: "none",
        cursor: "default",
      }}
    >
      <div
        style={{
          padding: "0.25rem 1rem 0.25rem 1.25rem",
          fontSize: "0.75rem",
          fontWeight: 700,
          letterSpacing: "0.04em",
          textTransform: "uppercase",
          color: "var(--color-primary)",
        }}
      >
        excaliagent
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {items.map((item) => (
          <li key={item.label} role="menuitem">
            <button
              type="button"
              className="context-menu-item"
              style={{ color: "var(--popup-text-color)" }}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                onAction(item);
              }}
            >
              <div className="context-menu-item__label">{item.label}</div>
            </button>
          </li>
        ))}
      </ul>
    </div>,
    host,
  );
}
