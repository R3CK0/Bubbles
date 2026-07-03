const cad0 = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 });
const cad2 = new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** $1,234 — dashboards round to dollars. */
export function fmt(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return cad0.format(n);
}

/** $1,234.56 — tables and editors keep cents. */
export function fmtC(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return cad2.format(n);
}

/** ▲ +$120 / ▼ −$80 style delta with glyph (color is the caller's job). */
export function fmtDelta(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  const glyph = n >= 0 ? "▲" : "▼";
  return `${glyph} ${cad0.format(Math.abs(n))}`;
}

export function fmtPct(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2026-07" → "Jul 2026" */
export function monthLabel(m: string): string {
  const [y, mo] = m.split("-");
  return `${MONTHS[Number(mo) - 1]} ${y}`;
}

/** "2026-07" → "Jul" */
export function monthShort(m: string): string {
  return MONTHS[Number(m.split("-")[1]) - 1];
}

/** "2026-07-14" → "Jul 14" */
export function dayLabel(d: string): string {
  const [, m, day] = d.split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(day)}`;
}

export function daysUntil(date: string): number {
  return Math.round((new Date(date + "T00:00:00").getTime() - Date.now()) / 86_400_000);
}

/** SVG path pair (line + closed area) for a sparkline in a w×h viewBox. */
export function sparkPaths(values: number[], w = 150, h = 40): { line: string; area: string } {
  if (values.length < 2) return { line: "", area: "" };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [
    (i / (values.length - 1)) * w,
    h - 3 - ((v - min) / span) * (h - 6),
  ]);
  const line = "M" + pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join("L");
  const area = line + `L${w},${h}L0,${h}Z`;
  return { line, area };
}

/** Read a CSS token off <html> — lets chart options track the active theme. */
export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Categorical palette for chart series (accent-first). */
export function palette(): string[] {
  return [cssVar("--accent"), "#5EA8D9", cssVar("--gold"), "#B48BD9", cssVar("--warn"), "#6FBF9E", "#D98BA6", "#8A948F", "#7A9ED9", "#C9A66B"];
}
