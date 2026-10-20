// The board's own buttons in Excalidraw's top-right corner. Each has an icon
// in Excalidraw's style and a label that collapses into its tooltip when the
// window gets narrow (see topbar.ts), so labels never wrap or overlap.
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { TopBarLayout } from "./topbar.ts";
import "./topbar.css";

/** Tabler-style icon, drawn like Excalidraw's own (24px grid, 1.25 stroke). */
function icon(...paths: string[]) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      role="img"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

export const PlusIcon = icon("M12 5v14", "M5 12h14");
/** Two cards stacked in a column: what "Tidy" does to a lane. */
export const TidyIcon = icon(
  "M6 4h12a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-2a2 2 0 0 1 2 -2z",
  "M6 14h12a2 2 0 0 1 2 2v2a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-2a2 2 0 0 1 2 -2z",
);
/** A smiling face: the cards' characters. */
export const CharactersIcon = icon(
  "M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0 -18z",
  "M9 10h.01",
  "M15 10h.01",
  "M9.5 15a3.5 3.5 0 0 0 5 0",
);
/** A clock turning back: earlier (dormant) sessions. */
export const SessionsIcon = icon("M12 8v4l2 2", "M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5");

/** Our buttons' container; in the column layout it sits below Excalidraw's own tools. */
export function TopBar({ layout, children }: { layout: TopBarLayout; children: ReactNode }) {
  const [top, setTop] = useState<number>();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (layout !== "column") return;
    // Below whatever Excalidraw shows at the right edge: its mobile tool column,
    // or (desktop) its top-right row, which then holds just the Library button.
    const place = () => {
      const root = ref.current?.closest(".excalidraw") ?? document;
      const above = [".mobile-misc-tools-container", ".layer-ui__wrapper__top-right"]
        .map((sel) => root.querySelector(sel)?.getBoundingClientRect())
        .filter((r): r is DOMRect => !!r && r.height > 0)
        .map((r) => r.bottom);
      setTop((above.length ? Math.max(...above) : 64) + 8);
    };
    place();
    const ro = new ResizeObserver(place);
    for (const sel of [".mobile-misc-tools-container", ".layer-ui__wrapper__top-right"]) {
      const el = document.querySelector(sel);
      if (el) ro.observe(el);
    }
    window.addEventListener("resize", place);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [layout]);
  return (
    <div
      ref={ref}
      className={`excaliagent-top excaliagent-top--${layout}`}
      style={layout === "column" && top !== undefined ? { top } : undefined}
    >
      {children}
    </div>
  );
}

/** A plain button styled like Excalidraw's Library button: icon, then a label that may collapse. */
export function TopButton(props: { icon: ReactNode; label: string; name: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      className="sidebar-trigger excaliagent-top-button"
      title={props.title}
      aria-label={props.name}
      onClick={props.onClick}
    >
      {props.icon}
      <span className="sidebar-trigger__label">{props.label}</span>
    </button>
  );
}
