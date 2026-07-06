import type { GoalCategory } from "../api/types";

type Verdict = "yes" | "tight" | "no";

/**
 * The display status for a goal — color, chip label, and whether it counts as
 * "on track". A spending goal is its own budget envelope: it reads green "on
 * track" right up until tagged spending passes the budgeted amount, then amber
 * "over budget". The solver's funding verdict (yes/tight/no) only governs saving
 * and loan goals.
 */
export function goalStatus(
  category: GoalCategory,
  funded: number,
  target: number,
  feasible: Verdict | undefined,
): { color: string; label: string; onTrack: boolean } {
  if (category === "spending") {
    return funded > target
      ? { color: "var(--warn)", label: "✕ over budget", onTrack: false }
      : { color: "var(--accent)", label: "✓ on track", onTrack: true };
  }
  const map = {
    yes: { color: "var(--accent)", label: "✓ on track", onTrack: true },
    tight: { color: "var(--warn)", label: "~ tight", onTrack: false },
    no: { color: "var(--danger)", label: "✕ not feasible", onTrack: false },
  } as const;
  return map[feasible ?? "yes"];
}
