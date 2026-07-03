import { useState } from "react";
import { useAction, usePersons } from "../api/hooks";
import { api } from "../api/client";
import type { Debt } from "../api/types";
import { Field } from "../components/ui";

const KINDS = ["credit_card", "student_loan", "line_of_credit", "auto_loan", "mortgage", "personal", "other"] as const;

/** Short-term = revolving credit (cards, LOC) + other; long-term = installment loans. */
export const SHORT_TERM_KINDS = new Set<Debt["kind"]>(["credit_card", "line_of_credit", "other"]);
export const isShortTerm = (d: Debt) => SHORT_TERM_KINDS.has(d.kind);

export interface DebtDraft { debtId?: string; name: string; kind: (typeof KINDS)[number]; currentBalance: number; apr: number; minPayment: number | null; personId: string | null; accountId?: string | null }

/** Shared debt form (also used by Accounts wizard + onboarding). */
export function DebtForm({ initial, onSubmit, submitLabel }: { initial: DebtDraft; onSubmit: (d: DebtDraft) => void; submitLabel: string }) {
  const persons = usePersons();
  const [d, setD] = useState(initial);
  const movesScreens = initial.debtId && SHORT_TERM_KINDS.has(initial.kind) !== SHORT_TERM_KINDS.has(d.kind);
  return (
    <div className="col" style={{ gap: 13 }}>
      <Field label="Name"><input className="input" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="e.g. TD Visa" /></Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Kind">
          <select className="input" value={d.kind} onChange={(e) => setD({ ...d, kind: e.target.value as DebtDraft["kind"] })}>
            {KINDS.map((k) => <option key={k} value={k}>{k.replace(/_/g, " ")}</option>)}
          </select>
        </Field>
        <Field label="Current balance"><input className="input num" type="number" min={0} value={d.currentBalance || ""} onChange={(e) => setD({ ...d, currentBalance: Number(e.target.value) })} /></Field>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <Field label="APR %"><input className="input num" type="number" min={0} max={100} step={0.01} value={d.apr || ""} onChange={(e) => setD({ ...d, apr: Number(e.target.value) })} /></Field>
        <Field label="Min payment"><input className="input num" type="number" min={0} value={d.minPayment ?? ""} onChange={(e) => setD({ ...d, minPayment: e.target.value ? Number(e.target.value) : null })} /></Field>
        <Field label="Whose?">
          <select className="input" value={d.personId ?? ""} onChange={(e) => setD({ ...d, personId: e.target.value || null })}>
            <option value="">Joint</option>
            {(persons.data?.persons ?? []).map((p) => <option key={p.person_id} value={p.person_id}>{p.display_name}</option>)}
          </select>
        </Field>
      </div>
      {movesScreens && (
        <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
          ↪ Saving moves this debt to the {SHORT_TERM_KINDS.has(d.kind) ? "short-term" : "long-term"} debt screen.
        </div>
      )}
      <button className="btn" disabled={!d.name || d.apr < 0} onClick={() => onSubmit(d)}>{submitLabel}</button>
    </div>
  );
}

export function debtBody(d: DebtDraft) {
  return { name: d.name, kind: d.kind, currentBalance: d.currentBalance, apr: d.apr, minPayment: d.minPayment, personId: d.personId, accountId: d.accountId ?? null };
}

export function toDraft(d: Debt): DebtDraft {
  return { debtId: d.debt_id, name: d.name, kind: d.kind, currentBalance: d.current_balance, apr: d.apr, minPayment: d.min_payment, personId: d.person_id };
}

/** Create/update + paid-off actions shared by both debt screens. */
export function useDebtActions() {
  const save = useAction(
    (d: DebtDraft) => d.debtId
      ? api(`/api/debts/${d.debtId}`, { method: "PATCH", json: { name: d.name, kind: d.kind, currentBalance: d.currentBalance, apr: d.apr, minPayment: d.minPayment, personId: d.personId } })
      : api("/api/debts", { method: "POST", json: debtBody(d) }),
    ["debts", "networth", "overview", "goals"],
  );
  const payOff = useAction(
    (debtId: string) => api(`/api/debts/${debtId}`, { method: "PATCH", json: { status: "paid_off", currentBalance: 0 } }),
    ["debts", "networth", "overview"],
  );
  return { save, payOff };
}
