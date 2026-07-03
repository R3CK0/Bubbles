import { ReactNode, useState } from "react";

/**
 * Hover tooltip. Bare `<Tip text="…"/>` renders a small ⓘ dot; wrap children
 * to make any element the hover target. Pure CSS-positioned, theme-aware.
 */
export function Tip({ text, children, below }: { text: string; children?: ReactNode; below?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      style={{ position: "relative", display: "inline-flex", alignItems: "center", verticalAlign: "middle" }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      {children ?? <span className="tip-dot">?</span>}
      {open && (
        <span className="tip-pop" style={below ? { top: "calc(100% + 7px)", bottom: "auto" } : undefined} role="tooltip">
          {text}
        </span>
      )}
    </span>
  );
}
