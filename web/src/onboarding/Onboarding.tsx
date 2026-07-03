import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useAction, useApi, useInvalidate, usePersons, useVault } from "../api/hooks";
import { api } from "../api/client";
import type { BudgetView, Category, GoalsView, Item, RegistryItem, Settings, TaxEstimate, TaxProfile } from "../api/types";
import { Card, Field, Spinner } from "../components/ui";
import { HouseholdIncomeEditor } from "../components/HouseholdIncomeEditor";
import { fmt, fmtC } from "../lib/format";
import { reconcile, ReconcileMatch } from "../lib/reconcile";
import { ExtraIncome, extraGrossAnnual, extraNetAnnual, parseExtra } from "../lib/tax";
import { AddBankWizard } from "../pages/AddBankWizard";
import { BillForm, BillDraft, billBody } from "../pages/Bills";
import { GoalForm } from "../pages/Goals";
import { useUi } from "../stores/ui";

const STEPS = ["Household", "Income", "Budget", "Connect", "Recurring", "Goals", "History & reconcile"] as const;
const YEAR = new Date().getFullYear();
const THIS_MONTH = new Date().toISOString().slice(0, 7);

export function Onboarding() {
  const nav = useNavigate();
  const ui = useUi();
  const [step, setStep] = useState(0);

  useEffect(() => {
    document.documentElement.dataset.theme = ui.theme;
  }, [ui.theme]);

  const finish = () => {
    localStorage.setItem("bubbles.onboarded", "1");
    nav("/");
  };

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", position: "relative", overflowX: "hidden" }}>
      <div style={{ position: "fixed", inset: 0, pointerEvents: "none", background: "radial-gradient(52% 46% at 28% 16%, var(--accent-soft), transparent 70%)", animation: "bb-drift 120s ease-in-out infinite" }} />
      <div style={{ position: "relative", maxWidth: 780, margin: "0 auto", padding: "44px 24px 80px" }}>
        <div className="row" style={{ gap: 12, marginBottom: 8 }}>
          <div style={{ width: 36, height: 36, borderRadius: "50%", background: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--bg)", fontWeight: 700, fontSize: 18 }}>b</div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>Welcome to Bubbles</div>
        </div>
        <div className="muted" style={{ fontSize: 13.5, marginBottom: 26, lineHeight: 1.5 }}>
          Seven quick steps: who you are, what you earn, your budget, where your money lives, what repeats, what you're saving for — then we pull your history and tidy it up together.
        </div>

        <div className="row" style={{ gap: 6, marginBottom: 28 }}>
          {STEPS.map((s, i) => (
            <div key={s} style={{ flex: 1, cursor: i < step ? "pointer" : "default" }} onClick={() => i < step && setStep(i)}>
              <div style={{ height: 4, borderRadius: 2, background: i < step ? "var(--accent)" : i === step ? "color-mix(in srgb, var(--accent) 50%, var(--surface-2))" : "var(--surface-2)", transition: "background .3s" }} />
              <div style={{ fontSize: 10.5, fontWeight: 600, marginTop: 5, color: i <= step ? "var(--accent)" : "var(--ink-muted)", whiteSpace: "nowrap" }}>{i + 1}. {s}</div>
            </div>
          ))}
        </div>

        <div key={step} style={{ animation: "bb-pagein .3s ease-out" }}>
          {step === 0 && <StepHousehold onNext={() => setStep(1)} />}
          {step === 1 && <StepIncome onNext={() => setStep(2)} />}
          {step === 2 && <StepBudget onNext={() => setStep(3)} />}
          {step === 3 && <StepConnect onNext={() => setStep(4)} />}
          {step === 4 && <StepRecurring onNext={() => setStep(5)} />}
          {step === 5 && <StepGoals onNext={() => setStep(6)} />}
          {step === 6 && <StepReconcile onFinish={finish} />}
        </div>

        <div className="muted" style={{ textAlign: "center", marginTop: 30, fontSize: 12 }}>
          <span className="link" onClick={finish}>Skip setup for now →</span>
        </div>
      </div>
    </div>
  );
}

// ---- step 1: household members + buffers ----
function StepHousehold({ onNext }: { onNext: () => void }) {
  const persons = usePersons();
  const settings = useApi<{ settings: Settings }>(["settings"], "/api/settings");
  const [name, setName] = useState("");
  const [bufferFloor, setBufferFloor] = useState("1000");
  const [bufferTarget, setBufferTarget] = useState("5000");

  useEffect(() => {
    const s = settings.data?.settings;
    if (s?.buffer_floor) setBufferFloor(s.buffer_floor);
    if (s?.buffer_target) setBufferTarget(s.buffer_target);
  }, [settings.data]);

  const addPerson = useAction(
    (n: string) => api("/api/persons", { method: "POST", json: { personId: n.toLowerCase().replace(/[^a-z0-9]+/g, "-"), displayName: n } }),
    ["persons"],
  );
  const saveSettings = useAction(
    () => api("/api/settings", { method: "PUT", json: { buffer_floor: Number(bufferFloor) || 0, buffer_target: Number(bufferTarget) || 0 } }),
    ["settings"],
  );

  return (
    <Card style={{ padding: 28 }}>
      <div style={{ fontSize: 17, fontWeight: 600 }}>Who's in the household?</div>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 4, marginBottom: 16 }}>Every account, bill, and goal can belong to one of you — or be joint.</div>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 20 }}>
        {(persons.data?.persons ?? []).map((p) => (
          <span key={p.person_id} className="chip chip-accent" style={{ fontSize: 13, padding: "8px 14px" }}>{p.display_name}</span>
        ))}
        <input className="input" style={{ width: 180 }} placeholder="Add a member + Enter" value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && name.trim()) { addPerson.mutate(name.trim()); setName(""); } }} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 20 }}>
        <Field label="Cash buffer floor" hint="we warn when projected balances dip below this">
          <input className="input num" type="number" min={0} value={bufferFloor} onChange={(e) => setBufferFloor(e.target.value)} />
        </Field>
        <Field label="Buffer target" hint="the planner funds this cushion before goals">
          <input className="input num" type="number" min={0} value={bufferTarget} onChange={(e) => setBufferTarget(e.target.value)} />
        </Field>
      </div>
      <button className="btn" disabled={(persons.data?.persons.length ?? 0) === 0}
        onClick={() => { saveSettings.mutate(); onNext(); }}>Continue →</button>
    </Card>
  );
}

// ---- step 2: income per member — gross + weekly take-home → after-tax picture ----
// (the editor itself is shared with Settings: components/HouseholdIncomeEditor)

function StepIncome({ onNext }: { onNext: () => void }) {
  return (
    <Card style={{ padding: 28 }}>
      <div style={{ fontSize: 17, fontWeight: 600 }}>What does everyone earn?</div>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 4, marginBottom: 16, lineHeight: 1.5 }}>
        Gross salary runs through the {YEAR} federal + Québec brackets and payroll (QPP/QPIP/EI). Your <b>weekly take-home</b> — what actually hits the bank — tells us the rest: the gap is your other paycheque deductions (health insurance, pension…), and the budget will run on real after-tax money.
      </div>
      <HouseholdIncomeEditor submitLabel="Continue →" onDone={onNext} />
    </Card>
  );
}

// ---- step 3: create the budget ----
const STARTER_CATEGORIES: { id: string; name: string }[] = [
  { id: "housing", name: "Housing & rent" },
  { id: "groceries", name: "Groceries" },
  { id: "transport", name: "Transport & car" },
  { id: "utilities", name: "Utilities & internet" },
  { id: "insurance", name: "Insurance" },
  { id: "dining", name: "Dining & fun" },
  { id: "subscriptions", name: "Subscriptions" },
  { id: "health", name: "Health & fitness" },
  { id: "personal", name: "Personal & shopping" },
  { id: "travel", name: "Travel" },
];

interface BudgetLineDraft { id: string; name: string; include: boolean; amount: string; existing: boolean }

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function StepBudget({ onNext }: { onNext: () => void }) {
  const persons = usePersons();
  const categories = useApi<{ categories: Category[] }>(["categories"], "/api/categories");
  const budget = useApi<BudgetView>(["budget.view", "combined", THIS_MONTH], `/api/budget?month=${THIS_MONTH}`);
  const profiles = useApi<{ profiles: TaxProfile[] }>(["tax.profiles", YEAR], `/api/tax/profile?year=${YEAR}`);
  const estimate = useApi<TaxEstimate>(["tax.estimate", "combined", YEAR], `/api/tax/estimate?year=${YEAR}`);

  const [rows, setRows] = useState<BudgetLineDraft[] | null>(null);
  const [income, setIncome] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invalidate = useInvalidate();

  // initialize once everything needed has loaded: existing categories win
  // over the starter template; amounts prefill from any current budget
  useEffect(() => {
    if (rows !== null || !categories.data || !budget.data) return;
    const budgetByCat = new Map(budget.data.rows.map((r) => [r.categoryId, r.budget]));
    const existing = categories.data.categories.filter((c) => c.kind === "expense" && c.parent_id === null && !c.archived);
    const base: BudgetLineDraft[] = existing.length > 0
      ? existing.map((c) => ({ id: c.category_id, name: c.name, include: true, amount: String(budgetByCat.get(c.category_id) || ""), existing: true }))
      : STARTER_CATEGORIES.map((c) => ({ id: c.id, name: c.name, include: true, amount: "", existing: false }));
    setRows(base);
  }, [categories.data, budget.data, rows]);

  // default household monthly income = AFTER-TAX money, from step 2:
  // weekly take-home (job reality) + extra income net at the marginal rate;
  // else the bracket estimate's net (already covers everything); else gross/12
  useEffect(() => {
    if (income !== null || !profiles.data) return;
    if (!estimate.data && !estimate.isError) return;
    let monthly = 0;
    for (const p of profiles.data.profiles) {
      const est = estimate.data?.perPerson.find((x) => x.personId === p.person_id);
      const extra = parseExtra(p.other_income_json);
      if (p.weekly_take_home && p.weekly_take_home > 0) {
        monthly += (p.weekly_take_home * 52) / 12 + (est ? extraNetAnnual(extra, est.marginalRate) / 12 : 0);
        continue;
      }
      monthly += est
        ? (est.totalIncome - est.totalIncomeTax - est.payroll.total) / 12
        : (p.employment_income ?? 0) / 12;
    }
    setIncome(monthly > 0 ? String(Math.round(monthly)) : "");
  }, [profiles.data, estimate.data, estimate.isError, income]);

  const totalBudgeted = (rows ?? []).filter((r) => r.include).reduce((t, r) => t + (Number(r.amount) || 0), 0);
  const monthlyIncome = Number(income) || 0;
  const remaining = monthlyIncome - totalBudgeted;

  const submit = async () => {
    if (!rows) return;
    setSaving(true);
    setError(null);
    try {
      const included = rows.filter((r) => r.include && r.name.trim());
      // 1. make sure every category exists (upsert)
      await api("/api/categories", {
        method: "POST",
        json: { categoryId: "income", parentId: null, name: "Income", kind: "income", sortOrder: 0, archived: false },
      });
      for (const [i, r] of included.entries()) {
        await api("/api/categories", {
          method: "POST",
          json: { categoryId: r.id, parentId: null, name: r.name.trim(), kind: "expense", sortOrder: i + 1, archived: false },
        });
      }
      // 2. write the first budget version, effective this month
      const lines = [
        ...(monthlyIncome > 0 ? [{ categoryId: "income", personId: null, monthlyAmount: monthlyIncome }] : []),
        ...included.filter((r) => Number(r.amount) > 0).map((r) => ({ categoryId: r.id, personId: null, monthlyAmount: Number(r.amount) })),
      ];
      if (lines.length > 0) {
        await api("/api/budget/lines", { method: "PUT", json: { effectiveFrom: THIS_MONTH, name: "Starter budget", lines } });
      }
      invalidate(["budget", "categories", "cashflow", "overview"]);
      onNext();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card style={{ padding: 28 }}>
      <div style={{ fontSize: 17, fontWeight: 600 }}>Create your budget</div>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 4, marginBottom: 16 }}>
        Household is set — now decide where the after-tax money goes each month. The income figure below is what actually lands in your accounts (from your take-home, not gross pay). Untick what doesn't apply, adjust the amounts, add your own categories. This becomes budget v1 (effective {THIS_MONTH}); every page measures against it.
      </div>

      <div className="panel spread" style={{ padding: "12px 16px", marginBottom: 16 }}>
        <div className="row" style={{ gap: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Monthly income after tax{(persons.data?.persons.length ?? 0) > 1 ? " (household)" : ""}</span>
          <input className="input num" type="number" min={0} style={{ width: 130 }} value={income ?? ""} onChange={(e) => setIncome(e.target.value)} />
        </div>
        <div className="num" style={{ fontSize: 13, fontWeight: 700, color: remaining >= 0 ? "var(--accent)" : "var(--danger)" }}>
          {fmt(remaining)} <span className="muted" style={{ fontWeight: 400 }}>left after budget</span>
        </div>
      </div>

      <div className="col" style={{ gap: 8 }}>
        {(rows ?? []).map((r, i) => (
          <div key={r.id} className="row" style={{ gap: 10, opacity: r.include ? 1 : 0.45 }}>
            <input type="checkbox" checked={r.include} style={{ accentColor: "var(--accent)" }}
              onChange={(e) => setRows((s) => s!.map((x, j) => (j === i ? { ...x, include: e.target.checked } : x)))} />
            <input className="input" style={{ flex: 1 }} value={r.name} disabled={r.existing}
              onChange={(e) => setRows((s) => s!.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            <div className="row" style={{ gap: 6 }}>
              <input className="input num" type="number" min={0} placeholder="0" style={{ width: 120 }} value={r.amount}
                onChange={(e) => setRows((s) => s!.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} />
              <span className="muted" style={{ fontSize: 11.5 }}>/mo</span>
            </div>
          </div>
        ))}
        <div className="row" style={{ gap: 10, marginTop: 4 }}>
          <input className="input" style={{ flex: 1 }} placeholder="Add your own category + Enter" value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && custom.trim() && rows) {
                const id = slugify(custom);
                if (!rows.some((r) => r.id === id)) setRows([...rows, { id, name: custom.trim(), include: true, amount: "", existing: false }]);
                setCustom("");
              }
            }} />
        </div>
      </div>

      <div className="spread" style={{ marginTop: 18 }}>
        <div className="muted num" style={{ fontSize: 12.5 }}>Budgeted: <b style={{ color: "var(--ink)" }}>{fmt(totalBudgeted)}</b>/mo</div>
        {error && <span style={{ color: "var(--danger)", fontSize: 12 }}>⚠ {error}</span>}
        <button className="btn" disabled={saving || !rows} onClick={submit}>
          {saving ? <Spinner /> : null} Save budget & continue →
        </button>
      </div>
    </Card>
  );
}

// ---- step 4: connect banks (loops the add-bank wizard) ----
function StepConnect({ onNext }: { onNext: () => void }) {
  const vault = useVault();
  const locked = vault.data ? !vault.data.unlocked : false;
  const items = useApi<{ items: Item[] }>(["items"], locked ? null : "/api/items", { retry: false });
  const [wizardOpen, setWizardOpen] = useState(false);

  return (
    <Card style={{ padding: 28 }}>
      <div style={{ fontSize: 17, fontWeight: 600 }}>Connect your banks</div>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 4, marginBottom: 16 }}>
        Link each institution, pick the accounts to track, and tell Bubbles what each one is — spending cash, savings, FHSA/TFSA/RRSP investing, a credit card, or a loan. Credit and loan accounts can become tracked debts with an APR on the spot.
      </div>
      {locked ? (
        <div className="panel" style={{ padding: 16, fontSize: 12.5, color: "var(--warn)", lineHeight: 1.6 }}>
          🔒 The Plaid vault is locked (YubiKey needed on the server). You can continue setup and link banks later from the Accounts page.
        </div>
      ) : (
        <div className="col" style={{ gap: 10 }}>
          {(items.data?.items ?? []).map((it) => (
            <div key={it.item_id} className="panel spread" style={{ padding: "12px 16px" }}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{it.institution_name ?? it.item_id}</span>
              <span className="chip chip-accent">linked ✓</span>
            </div>
          ))}
          <button className="btn-ghost" style={{ justifyContent: "center", padding: 14, borderStyle: "dashed" }} onClick={() => setWizardOpen(true)}>
            + Link {(items.data?.items.length ?? 0) > 0 ? "another" : "your first"} bank
          </button>
        </div>
      )}
      <button className="btn" style={{ marginTop: 20 }} onClick={onNext}>Continue →</button>
      {wizardOpen && <AddBankWizard onClose={() => setWizardOpen(false)} />}
    </Card>
  );
}

// ---- step 4: recurring payments ----
function StepRecurring({ onNext }: { onNext: () => void }) {
  const categories = useApi<{ categories: Category[] }>(["categories"], "/api/categories");
  const registry = useApi<{ registry: RegistryItem[] }>(["bills.registry", "active"], "/api/bills/registry?status=active");
  const [draft, setDraft] = useState<BillDraft | null>(null);
  const save = useAction((d: BillDraft) => api("/api/bills", { method: "POST", json: billBody(d) }), ["bills"]);
  const remove = useAction((rpId: string) => api(`/api/bills/${rpId}`, { method: "DELETE" }), ["bills"]);

  return (
    <Card style={{ padding: 28 }}>
      <div style={{ fontSize: 17, fontWeight: 600 }}>What repeats every month?</div>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 4, marginBottom: 16 }}>
        Rent, hydro, phone, insurance, subscriptions… In the last step we'll cross-check this list against what we actually find in your transaction history.
      </div>
      <div className="col" style={{ gap: 8, marginBottom: 16 }}>
        {(registry.data?.registry ?? []).map((r) => (
          <div key={r.rp_id} className="panel spread" style={{ padding: "10px 14px" }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{r.name} <span className="muted" style={{ fontWeight: 400 }}>· {fmtC(r.expected_amount)} · {r.frequency}</span></span>
            <span style={{ cursor: "pointer", color: "var(--ink-muted)" }} onClick={() => remove.mutate(r.rp_id)}>×</span>
          </div>
        ))}
      </div>
      {draft ? (
        <div className="panel" style={{ padding: 16 }}>
          <BillForm draft={draft} setDraft={setDraft} categories={categories.data?.categories ?? []}
            submitLabel="Add recurring payment"
            onSubmit={() => { save.mutate(draft); setDraft(null); }} />
        </div>
      ) : (
        <button className="btn-ghost" style={{ justifyContent: "center", padding: 12, width: "100%", borderStyle: "dashed" }}
          onClick={() => setDraft({ name: "", expectedAmount: 0, frequency: "monthly", anchorDate: new Date().toISOString().slice(0, 10), personId: null, categoryId: null, autopay: false, reimbursedBy: null })}>
          + Add a recurring payment
        </button>
      )}
      <button className="btn" style={{ marginTop: 20 }} onClick={onNext}>Continue →</button>
    </Card>
  );
}

// ---- step 5: goals ----
function StepGoals({ onNext }: { onNext: () => void }) {
  const view = useApi<GoalsView>(["goals.view", "combined"], "/api/goals");
  const [adding, setAdding] = useState(false);
  const create = useAction((d: object) => api("/api/goals", { method: "POST", json: d }), ["goals"]);

  return (
    <Card style={{ padding: 28 }}>
      <div style={{ fontSize: 17, fontWeight: 600 }}>What are you working toward?</div>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 4, marginBottom: 16 }}>House, trip, emergency fund, paying off a card — the planner checks feasibility against your free cash flow.</div>
      <div className="row" style={{ gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {(view.data?.goals ?? []).map((g) => (
          <span key={g.goal_id} className="chip chip-accent" style={{ fontSize: 12.5, padding: "7px 12px" }}>{g.name} · {fmt(g.target_amount)}</span>
        ))}
      </div>
      {adding ? (
        <div className="panel" style={{ padding: 16 }}>
          <GoalForm submitLabel="Add goal" onSubmit={(d) => { create.mutate(d); setAdding(false); }} />
        </div>
      ) : (
        <button className="btn-ghost" style={{ justifyContent: "center", padding: 12, width: "100%", borderStyle: "dashed" }} onClick={() => setAdding(true)}>+ Add a goal</button>
      )}
      <button className="btn" style={{ marginTop: 20 }} onClick={onNext}>Continue →</button>
    </Card>
  );
}

// ---- step 6: pull history + reconcile recurring ----
type Phase = "idle" | "pulling" | "reconciling" | "done";

function StepReconcile({ onFinish }: { onFinish: () => void }) {
  const vault = useVault();
  const qc = useQueryClient();
  const invalidate = useInvalidate();
  const locked = vault.data ? !vault.data.unlocked : false;
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [matches, setMatches] = useState<ReconcileMatch[]>([]);
  const [unmatchedManual, setUnmatchedManual] = useState<RegistryItem[]>([]);
  const [unmatchedProposed, setUnmatchedProposed] = useState<RegistryItem[]>([]);
  const [resolved, setResolved] = useState<Set<string>>(new Set());

  const pull = async () => {
    setPhase("pulling");
    setError(null);
    try {
      // full nightly pipeline: sync → snapshots → categorize → recurring DETECTION
      await api("/api/jobs/nightly/run", { method: "POST", json: {} });
    } catch (e) {
      // vault locked or Plaid unreachable — reconcile whatever is local
      setError(e instanceof Error ? e.message : String(e));
    }
    try {
      const [active, proposed] = await Promise.all([
        api<{ registry: RegistryItem[] }>("/api/bills/registry?status=active"),
        api<{ registry: RegistryItem[] }>("/api/bills/registry?status=proposed"),
      ]);
      const manual = active.registry.filter((r) => r.source === "manual");
      const r = reconcile(manual, proposed.registry);
      setMatches(r.matches);
      setUnmatchedManual(r.unmatchedManual);
      setUnmatchedProposed(r.unmatchedProposed);
      setPhase("reconciling");
      invalidate([]);
      void qc;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  };

  const resolveMatch = async (m: ReconcileMatch, keep: "manual" | "detected") => {
    if (keep === "manual") {
      // your entry stands; drop the detected duplicate
      await api(`/api/bills/${m.proposed.rp_id}/dismiss`, { method: "POST", json: {} });
    } else {
      // the detected pattern is truer to reality; adopt it, retire the manual entry
      await api(`/api/bills/${m.proposed.rp_id}/accept`, { method: "POST", json: {} });
      await api(`/api/bills/${m.manual.rp_id}`, { method: "DELETE" });
    }
    setResolved((s) => new Set(s).add(m.manual.rp_id));
    invalidate(["bills"]);
  };

  const resolveProposed = async (r: RegistryItem, accept: boolean) => {
    await api(`/api/bills/${r.rp_id}/${accept ? "accept" : "dismiss"}`, { method: "POST", json: {} });
    setResolved((s) => new Set(s).add(r.rp_id));
    invalidate(["bills"]);
  };

  const outstanding = matches.filter((m) => !resolved.has(m.manual.rp_id)).length + unmatchedProposed.filter((r) => !resolved.has(r.rp_id)).length;

  return (
    <Card style={{ padding: 28 }}>
      <div style={{ fontSize: 17, fontWeight: 600 }}>Pull history & reconcile</div>
      <div className="muted" style={{ fontSize: 12.5, marginTop: 4, marginBottom: 18, lineHeight: 1.6 }}>
        We sync up to 24 months of transactions, auto-categorize them, and detect recurring payments — then cross-check what we found against the list you just gave us.
      </div>

      {phase === "idle" && (
        <div className="col" style={{ gap: 12 }}>
          {locked && <div className="panel" style={{ padding: 14, fontSize: 12.5, color: "var(--warn)" }}>🔒 Vault locked — the sync will be skipped, but we'll still reconcile against any local history.</div>}
          {error && <div style={{ color: "var(--danger)", fontSize: 12.5 }}>⚠ {error}</div>}
          <button className="btn" style={{ fontSize: 14, padding: "12px 20px", alignSelf: "flex-start" }} onClick={pull}>
            ⟳ Pull transaction history
          </button>
        </div>
      )}

      {phase === "pulling" && (
        <div className="row" style={{ gap: 12, padding: "20px 0", color: "var(--ink-muted)" }}>
          <Spinner size={18} /> Syncing banks, categorizing, detecting recurring payments… this can take a minute on first run.
        </div>
      )}

      {phase === "reconciling" && (
        <div className="col" style={{ gap: 18 }}>
          {error && <div className="panel" style={{ padding: 12, fontSize: 12, color: "var(--warn)" }}>Sync had trouble ({error}) — reconciling against local data.</div>}

          {matches.length > 0 && (
            <div>
              <div className="label" style={{ marginBottom: 10 }}>Matched — you told us, and we found it</div>
              <div className="col" style={{ gap: 10 }}>
                {matches.map((m) => (
                  <div key={m.manual.rp_id} className="panel" style={{ padding: 14, opacity: resolved.has(m.manual.rp_id) ? 0.45 : 1 }}>
                    <div className="spread" style={{ flexWrap: "wrap", gap: 10 }}>
                      <div style={{ fontSize: 13 }}>
                        <b>{m.manual.name}</b> <span className="muted">({fmtC(m.manual.expected_amount)} {m.manual.frequency})</span>
                        <span className="muted"> ↔ found </span>
                        <b>{m.proposed.name}</b> <span className="muted">({fmtC(m.proposed.expected_amount)} {m.proposed.frequency})</span>
                      </div>
                      {!resolved.has(m.manual.rp_id) ? (
                        <div className="row" style={{ gap: 8 }}>
                          <button className="btn" style={{ padding: "6px 12px" }} onClick={() => resolveMatch(m, "manual")}>Same bill — keep mine</button>
                          <button className="btn-ghost" onClick={() => resolveMatch(m, "detected")}>Use detected version</button>
                        </div>
                      ) : <span className="chip chip-accent">resolved ✓</span>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {unmatchedProposed.length > 0 && (
            <div>
              <div className="label" style={{ marginBottom: 10 }}>Found in history — you didn't mention these</div>
              <div className="col" style={{ gap: 10 }}>
                {unmatchedProposed.map((r) => (
                  <div key={r.rp_id} className="panel spread" style={{ padding: 14, opacity: resolved.has(r.rp_id) ? 0.45 : 1, flexWrap: "wrap", gap: 10 }}>
                    <span style={{ fontSize: 13 }}><b>{r.name}</b> <span className="muted">{fmtC(r.expected_amount)} · {r.frequency}</span></span>
                    {!resolved.has(r.rp_id) ? (
                      <div className="row" style={{ gap: 8 }}>
                        <button className="btn" style={{ padding: "6px 12px" }} onClick={() => resolveProposed(r, true)}>Track it</button>
                        <button className="btn-ghost" onClick={() => resolveProposed(r, false)}>Not recurring</button>
                      </div>
                    ) : <span className="chip chip-accent">resolved ✓</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {unmatchedManual.length > 0 && (
            <div>
              <div className="label" style={{ marginBottom: 10 }}>You mentioned these — not seen in history yet</div>
              <div className="col" style={{ gap: 6 }}>
                {unmatchedManual.map((r) => (
                  <div key={r.rp_id} className="muted" style={{ fontSize: 12.5 }}>
                    · <b style={{ color: "var(--ink)" }}>{r.name}</b> ({fmtC(r.expected_amount)} {r.frequency}) — kept as-is; it'll match automatically once a payment shows up
                  </div>
                ))}
              </div>
            </div>
          )}

          {matches.length === 0 && unmatchedProposed.length === 0 && (
            <div className="empty">Nothing to reconcile — either no history yet, or your list already matches reality perfectly.</div>
          )}

          <button className="btn" style={{ fontSize: 14, padding: "12px 20px", alignSelf: "flex-start" }} onClick={onFinish}>
            {outstanding > 0 ? `Finish anyway (${outstanding} unresolved)` : "Finish — open Bubbles 🎉"}
          </button>
        </div>
      )}
    </Card>
  );
}
