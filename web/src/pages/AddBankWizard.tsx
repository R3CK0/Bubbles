import { useState } from "react";
import { useAction, useInvalidate, usePersons } from "../api/hooks";
import { api } from "../api/client";
import type { ApiAccount } from "../api/types";
import { Modal, Spinner } from "../components/ui";
import { fmt } from "../lib/format";
import { DebtForm, debtBody, DebtDraft } from "./Debt";
import { REGISTERED_TYPES } from "./Accounts";

type Step = 0 | 1 | 2;

/** Plaid subtype → registered-type guess for the classify card. */
function guessType(a: ApiAccount): string | null {
  const sub = (a.subtype ?? "").toLowerCase();
  if (sub.includes("tfsa")) return "TFSA";
  if (sub.includes("rrsp") || sub.includes("rsp")) return "RRSP";
  if (sub.includes("fhsa")) return "FHSA";
  if (sub.includes("resp")) return "RESP";
  if (a.type === "investment") return "NONREG";
  return null;
}

export function AddBankWizard({ onClose, onFinished }: { onClose: () => void; onFinished?: () => void }) {
  const persons = usePersons();
  const invalidate = useInvalidate();
  const [step, setStep] = useState<Step>(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [itemId, setItemId] = useState<string | null>(null);
  const [bankName, setBankName] = useState<string>("");
  const [accounts, setAccounts] = useState<ApiAccount[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [cardIdx, setCardIdx] = useState(0);
  const [debtDraft, setDebtDraft] = useState<DebtDraft | null>(null);
  // classify state for the current card
  const [personId, setPersonId] = useState<string | null>(null);
  const [regType, setRegType] = useState<string | null>(null);
  const [purpose, setPurpose] = useState("");

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const { openPlaidLink } = await import("../lib/plaid");
      const { linkToken } = await api<{ linkToken: string }>("/api/link/token", { method: "POST", json: { clientUserId: "household" } });
      const publicToken = await openPlaidLink(linkToken);
      if (!publicToken) { setBusy(false); return; }
      const result = await api<{ itemId?: string; item_id?: string; institutionName?: string; institution_name?: string }>("/api/link/exchange", { method: "POST", json: { publicToken } });
      const id = (result.itemId ?? result.item_id) as string;
      setItemId(id);
      setBankName(result.institutionName ?? result.institution_name ?? "Your bank");
      const { accounts: fetched } = await api<{ accounts: ApiAccount[] }>(`/api/items/${id}/accounts/refresh`, { method: "POST", json: {} });
      setAccounts(fetched);
      setSelected(new Set(fetched.filter((a) => ["depository", "investment", "credit", "loan"].includes(a.type ?? "")).map((a) => a.accountId)));
      setStep(1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const selectedList = accounts.filter((a) => selected.has(a.accountId));
  const current = selectedList[cardIdx];

  const startClassify = () => {
    setCardIdx(0);
    primeCard(selectedList[0]);
    setStep(2);
  };
  const primeCard = (a: ApiAccount | undefined) => {
    if (!a) return;
    setPersonId(a.personId);
    setRegType(guessType(a));
    setPurpose("");
    setDebtDraft(null);
  };

  const confirmCard = async () => {
    if (!current) return;
    setBusy(true);
    try {
      await api(`/api/accounts/${current.accountId}`, { method: "PATCH", json: { personId, registeredType: regType, purpose: purpose || null, tracked: true } });
      // untracked accounts get persisted once, at the end
      if (cardIdx + 1 < selectedList.length) {
        setCardIdx(cardIdx + 1);
        primeCard(selectedList[cardIdx + 1]);
      } else {
        // persist tracked=false on the toggled-off rows, then kick the first sync
        await Promise.all(accounts.filter((a) => !selected.has(a.accountId)).map((a) => api(`/api/accounts/${a.accountId}`, { method: "PATCH", json: { tracked: false } })));
        if (itemId) api(`/api/items/${itemId}/sync`, { method: "POST", json: {} }).then(() => invalidate([])).catch(() => undefined);
        invalidate([]);
        onFinished?.();
        onClose();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveDebt = useAction((d: DebtDraft) => api("/api/debts", { method: "POST", json: debtBody(d) }), ["debts", "networth"]);

  const steps = ["Connect", "Select", "Classify"];

  return (
    <Modal title="Add a bank" onClose={onClose} width={620}>
      <div className="row" style={{ gap: 6, marginBottom: 20 }}>
        {steps.map((s, i) => (
          <div key={s} style={{ flex: 1 }}>
            <div style={{ height: 4, borderRadius: 2, background: i < step ? "var(--accent)" : i === step ? "color-mix(in srgb, var(--accent) 50%, var(--surface-2))" : "var(--surface-2)", transition: "background .3s" }} />
            <div style={{ fontSize: 11, fontWeight: 600, marginTop: 5, color: i <= step ? "var(--accent)" : "var(--ink-muted)" }}>{s}</div>
          </div>
        ))}
      </div>

      {error && <div style={{ color: "var(--danger)", fontSize: 12.5, marginBottom: 12 }}>⚠ {error}</div>}

      {step === 0 && (
        <div className="col" style={{ alignItems: "center", gap: 16, padding: "26px 0" }}>
          <div style={{ fontSize: 40 }}>🏦</div>
          <div className="muted" style={{ fontSize: 13, textAlign: "center", maxWidth: 380, lineHeight: 1.6 }}>
            Plaid's secure overlay opens next — your credentials never touch Bubbles. We pull up to 24 months of history after linking.
          </div>
          <button className="btn" style={{ fontSize: 14, padding: "12px 22px" }} disabled={busy} onClick={connect}>
            {busy ? <Spinner /> : null} {busy ? "Waiting for Plaid…" : "Connect with Plaid"}
          </button>
        </div>
      )}

      {step === 1 && (
        <div className="col" style={{ gap: 10 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{bankName} — choose what to track</div>
          {accounts.map((a, i) => {
            const on = selected.has(a.accountId);
            return (
              <div key={a.accountId} className="panel row" style={{ padding: "11px 14px", gap: 12, opacity: on ? 1 : 0.4, animation: "bb-rowin .3s ease-out both", animationDelay: `${i * 60}ms`, cursor: "pointer" }}
                onClick={() => setSelected((s) => { const n = new Set(s); if (n.has(a.accountId)) n.delete(a.accountId); else n.add(a.accountId); return n; })}>
                <input type="checkbox" readOnly checked={on} style={{ accentColor: "var(--accent)" }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{a.name ?? "Account"} <span className="muted" style={{ fontWeight: 400 }}>••{a.mask ?? ""}</span></div>
                  <span className="chip" style={{ marginTop: 4 }}>{a.type}{a.subtype ? ` · ${a.subtype}` : ""}</span>
                </div>
                <div className="num" style={{ fontSize: 13.5, fontWeight: 600 }}>{fmt(a.currentBalance)}</div>
              </div>
            );
          })}
          <div className="spread" style={{ marginTop: 6 }}>
            <span className="muted" style={{ fontSize: 12.5 }}>{selected.size} account{selected.size === 1 ? "" : "s"} will be tracked</span>
            <button className="btn" disabled={selected.size === 0} onClick={startClassify}>Continue →</button>
          </div>
        </div>
      )}

      {step === 2 && current && (
        <div className="col" style={{ gap: 16 }} key={current.accountId}>
          <div className="spread">
            <div className="label">Classify · {cardIdx + 1} of {selectedList.length}</div>
            <div className="num" style={{ fontSize: 13, fontWeight: 600 }}>{fmt(current.currentBalance)}</div>
          </div>
          <div style={{ fontSize: 18, fontWeight: 600, animation: "bb-popin .2s ease-out" }}>
            {current.name ?? "Account"} <span className="muted" style={{ fontWeight: 400 }}>••{current.mask ?? ""}</span>
            <span className="chip" style={{ marginLeft: 8 }}>{current.type}{current.subtype ? ` · ${current.subtype}` : ""}</span>
          </div>
          <div>
            <div className="label" style={{ marginBottom: 8 }}>Whose is it?</div>
            <div className="row" style={{ gap: 8 }}>
              {[{ id: null as string | null, name: "Joint" }, ...(persons.data?.persons ?? []).map((p) => ({ id: p.person_id as string | null, name: p.display_name }))].map((p) => (
                <button key={p.name} className={personId === p.id ? "btn" : "btn-ghost"} onClick={() => setPersonId(p.id)}>{p.name}</button>
              ))}
            </div>
          </div>
          <div>
            <div className="label" style={{ marginBottom: 8 }}>What is it?</div>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              {[null, ...REGISTERED_TYPES].map((t) => (
                <button key={t ?? "cash"} className={regType === t ? "btn" : "btn-ghost"}
                  style={t === guessType(current) && regType !== t ? { outline: "1px solid var(--accent)" } : undefined}
                  onClick={() => setRegType(t)}>
                  {t ?? (current.type === "credit" ? "Credit card" : current.type === "loan" ? "Loan/LOC" : "Cash / spending")}
                </button>
              ))}
            </div>
            {guessType(current) && <div className="muted" style={{ fontSize: 11, marginTop: 5 }}>outlined = our guess from Plaid's "{current.subtype}"</div>}
          </div>
          <div>
            <div className="label" style={{ marginBottom: 8 }}>Purpose (optional — lets goals auto-link)</div>
            <input className="input" list="bb-wiz-purposes" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. House down payment" />
            <datalist id="bb-wiz-purposes">
              {["Emergency fund", "Vacation sinking fund", "House down payment", "Bills account", "Wedding"].map((p) => <option key={p} value={p} />)}
            </datalist>
          </div>
          {(current.type === "credit" || current.type === "loan") && (
            <div className="panel" style={{ padding: 14 }}>
              <div className="spread">
                <span style={{ fontSize: 13, fontWeight: 600 }}>Track as a debt?</span>
                {!debtDraft
                  ? <button className="btn-ghost" onClick={() => setDebtDraft({ name: current.name ?? "Credit card", kind: current.type === "credit" ? "credit_card" : "line_of_credit", currentBalance: Math.abs(current.currentBalance ?? 0), apr: 19.99, minPayment: null, personId, accountId: current.accountId })}>Yes — set APR</button>
                  : <span className="chip chip-accent">will be added</span>}
              </div>
              {debtDraft && (
                <div style={{ marginTop: 12 }}>
                  <DebtForm initial={debtDraft} submitLabel="Save debt" onSubmit={(d) => { saveDebt.mutate(d); setDebtDraft(null); }} />
                </div>
              )}
            </div>
          )}
          <button className="btn" disabled={busy} onClick={confirmCard}>
            {busy ? <Spinner /> : null} {cardIdx + 1 < selectedList.length ? "Confirm → next account" : "Finish — start first sync"}
          </button>
        </div>
      )}
    </Modal>
  );
}
