import { ReactNode, useEffect } from "react";
import { sparkPaths } from "../lib/format";

export function Card({ children, style, className, onClick }: { children: ReactNode; style?: React.CSSProperties; className?: string; onClick?: () => void }) {
  return (
    <div className={`card ${className ?? ""}`} style={{ padding: 20, ...style }} onClick={onClick}>
      {children}
    </div>
  );
}

export function Seg<T extends string>({ items, value, onChange, subtle }: { items: { key: T; label: string }[]; value: T; onChange: (v: T) => void; subtle?: boolean }) {
  return (
    <div className={`seg ${subtle ? "seg-2" : ""}`}>
      {items.map((it) => (
        <div key={it.key} className={`seg-item ${it.key === value ? "on" : ""}`} onClick={() => onChange(it.key)}>
          {it.label}
        </div>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children, width }: { title: string; onClose: () => void; children: ReactNode; width?: number }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" style={{ width: width ?? 520, maxWidth: "94vw" }} onClick={(e) => e.stopPropagation()}>
        <div className="spread" style={{ padding: "18px 22px 0" }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{title}</div>
          <div onClick={onClose} style={{ cursor: "pointer", color: "var(--ink-muted)", fontSize: 20, lineHeight: 1 }}>×</div>
        </div>
        <div style={{ padding: 22 }}>{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="col" style={{ gap: 6, fontSize: 12 }}>
      <span style={{ fontWeight: 600, color: "var(--ink-muted)" }}>{label}</span>
      {children}
      {hint && <span className="muted" style={{ fontSize: 11 }}>{hint}</span>}
    </label>
  );
}

/** Progress ring (goal cards, wizard). pct 0..1. */
export function Ring({ pct, size = 72, color = "var(--accent)", label }: { pct: number; size?: number; color?: string; label?: string }) {
  const r = size / 2 - 8;
  const circ = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, pct));
  return (
    <div style={{ position: "relative", width: size, height: size, flex: "none" }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--line)" strokeWidth={7} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={7} strokeLinecap="round"
          strokeDasharray={circ} strokeDashoffset={circ * (1 - clamped)}
          style={{ transition: "stroke-dashoffset 1s cubic-bezier(.3,0,.2,1)" }} />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 700, color }} className="num">
        {label ?? `${Math.round(clamped * 100)}%`}
      </div>
    </div>
  );
}

export function Spark({ values, color = "var(--accent)", height = 38 }: { values: number[]; color?: string; height?: number }) {
  const { line, area } = sparkPaths(values);
  if (!line) return <div style={{ height }} />;
  return (
    <svg viewBox="0 0 150 40" preserveAspectRatio="none" style={{ width: "100%", height, overflow: "visible", display: "block" }}>
      <path d={area} fill={color} opacity={0.12} />
      <path d={line} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function StatusChip({ color, label }: { color: string; label: string }) {
  return <span className="chip" style={{ background: `color-mix(in srgb, ${color} 12%, transparent)`, color }}>{label}</span>;
}

export function Feasibility({ verdict }: { verdict: "yes" | "tight" | "no" }) {
  const map = { yes: ["var(--accent)", "✓ on track"], tight: ["var(--warn)", "~ tight"], no: ["var(--danger)", "✕ not feasible"] } as const;
  const [color, label] = map[verdict];
  return <StatusChip color={color} label={label} />;
}

export function EmptyState({ text, action }: { text: string; action?: ReactNode }) {
  return (
    <div className="empty col" style={{ alignItems: "center", gap: 12 }}>
      <div>{text}</div>
      {action}
    </div>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg className="spin" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
      <path d="M21 12a9 9 0 1 1-6.2-8.56" />
    </svg>
  );
}
