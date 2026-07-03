import type { RegistryItem } from "../api/types";

/**
 * Reconciliation between user-specified recurring payments (source=manual)
 * and recurring payments detected in transaction history (status=proposed).
 * Scored on name overlap, amount proximity, and frequency agreement.
 */
export interface ReconcileMatch {
  manual: RegistryItem;
  proposed: RegistryItem;
  score: number;
}

function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((t) => t.length > 2);
}

function nameScore(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la.includes(lb) || lb.includes(la)) return 3;
  const overlap = ta.filter((t) => tb.some((u) => u.includes(t) || t.includes(u))).length;
  return (overlap / Math.min(ta.length, tb.length)) * 3;
}

function amountScore(a: number, b: number): number {
  const diff = Math.abs(a - b) / Math.max(a, b, 1);
  if (diff <= 0.05) return 2;
  if (diff <= 0.15) return 1.2;
  if (diff <= 0.3) return 0.5;
  return 0;
}

export function reconcile(manual: RegistryItem[], proposed: RegistryItem[]): {
  matches: ReconcileMatch[];
  unmatchedManual: RegistryItem[];
  unmatchedProposed: RegistryItem[];
} {
  const matches: ReconcileMatch[] = [];
  const usedProposed = new Set<string>();
  const usedManual = new Set<string>();

  const candidates: ReconcileMatch[] = [];
  for (const m of manual) {
    for (const p of proposed) {
      let score = nameScore(m.name, p.name) + amountScore(m.expected_amount, p.expected_amount);
      if (m.frequency === p.frequency) score += 1.5;
      if (score >= 2.5) candidates.push({ manual: m, proposed: p, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  for (const c of candidates) {
    if (usedManual.has(c.manual.rp_id) || usedProposed.has(c.proposed.rp_id)) continue;
    usedManual.add(c.manual.rp_id);
    usedProposed.add(c.proposed.rp_id);
    matches.push(c);
  }
  return {
    matches,
    unmatchedManual: manual.filter((m) => !usedManual.has(m.rp_id)),
    unmatchedProposed: proposed.filter((p) => !usedProposed.has(p.rp_id)),
  };
}
