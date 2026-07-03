import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useAction, useApi, useCtx } from "../api/hooks";
import { api } from "../api/client";
import type { AiApplyResult, AiReviewCard, AiStatus, BudgetView, Category, ExcludedSummary, Frequency, GoalsView, InboxCard, RecurringFlagResult, Rule, TransferMarkResult, VarianceNarrative, BudgetVersion } from "../api/types";
import { Card, EmptyState, Field, Modal, Seg } from "../components/ui";
import { Tip } from "../components/Tip";
import { fmt, fmtDelta, dayLabel, monthLabel } from "../lib/format";

type Tab = "budget" | "inbox" | "manage";

/** New-subcategory id from its parent + name: "insurance" + "Car insurance" → "insurance-car-insurance". */
const subcategoryId = (parentId: string, name: string) =>
  `${parentId}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`;

export function Budget() {
  const { lens, month, q } = useCtx();
  const [params, setParams] = useSearchParams();
  const tab = (params.get("tab") as Tab) ?? "budget";
  const setTab = (t: Tab) => setParams(t === "budget" ? {} : { tab: t });

  const view = useApi<BudgetView>(["budget.view", lens, month], `/api/budget${q}`);
  const variances = useApi<{ narratives: VarianceNarrative[] }>(["budget.variances", lens, month], `/api/budget/variances${q}`);
  const categories = useApi<{ categories: Category[] }>(["categories"], "/api/categories");
  const excluded = useApi<ExcludedSummary>(["cashflow.excluded", lens, month], `/api/cashflow/excluded${q}`);
  const [versionsOpen, setVersionsOpen] = useState(false);
  const versions = useApi<{ versions: BudgetVersion[] }>(["budget.versions"], versionsOpen ? "/api/budget/versions" : null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [clearOpen, setClearOpen] = useState(false);

  const clearBudget = useAction(
    () => api("/api/budget/reset", { method: "POST", json: { effectiveFrom: month } }),
    ["budget", "overview", "cashflow"],
  );

  const saveBudget = useAction(
    (lines: { categoryId: string; personId: string | null; monthlyAmount: number }[]) =>
      api("/api/budget/lines", { method: "PUT", json: { effectiveFrom: month, lines } }),
    ["budget", "overview", "cashflow"],
  );
  const [subDraft, setSubDraft] = useState("");
  const addSubcategory = useAction(
    (d: { parentId: string; name: string; kind: Category["kind"] }) =>
      api("/api/categories", {
        method: "POST",
        json: { categoryId: subcategoryId(d.parentId, d.name), parentId: d.parentId, name: d.name, kind: d.kind },
      }),
    ["categories", "budget"],
  );
  // rename keeps the category_id stable (upsert only changes the name) so
  // existing budget lines and categorized transactions stay attached
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameCategory = useAction(
    (d: { categoryId: string; parentId: string; name: string; kind: Category["kind"] }) =>
      api("/api/categories", {
        method: "POST",
        json: { categoryId: d.categoryId, parentId: d.parentId, name: d.name, kind: d.kind },
      }),
    ["categories", "budget"],
  );
  const commitRename = (sub: { categoryId: string; name: string }, parentId: string, kind: Category["kind"]) => {
    const name = renameDraft.trim();
    if (name && name !== sub.name) renameCategory.mutate({ categoryId: sub.categoryId, parentId, name, kind });
    setRenaming(null);
  };

  const rows = view.data?.rows ?? [];
  const topExpense = rows.filter((r) => r.kind === "expense" && r.parentId === null);
  // subcategories come from the category tree, not the budget rows — a fresh
  // subcategory has no budget line and no spend yet, but must still render
  const rowByCat = useMemo(() => new Map(rows.map((r) => [r.categoryId, r])), [rows]);
  const cats = categories.data?.categories ?? [];
  const subsOf = (id: string) =>
    cats
      .filter((c) => c.parent_id === id && !c.archived)
      .map((c) => ({
        categoryId: c.category_id,
        name: c.name,
        budget: rowByCat.get(c.category_id)?.budget ?? 0,
        actual: rowByCat.get(c.category_id)?.actual ?? 0,
      }));
  const incomeRows = rows.filter((r) => r.kind === "income" && (r.budget > 0 || r.actual !== 0)).sort((a, b) => b.budget - a.budget);
  const incomeBudget = rows.filter((r) => r.kind === "income").reduce((t, r) => t + r.budget, 0);
  const incomeActual = rows.filter((r) => r.kind === "income").reduce((t, r) => t + r.actual, 0);
  // subcategory budgets roll up into their parent, so the spending total sums
  // every expense line — parents' own amounts plus all their subcategories'
  const expenseBudget = rows.filter((r) => r.kind === "expense").reduce((t, r) => t + r.budget, 0);
  const remaining = incomeBudget - expenseBudget;
  const narrativeFor = (id: string) => variances.data?.narratives.find((n) => n.categoryId === id);

  const commitEdit = (categoryId: string) => {
    const amount = edits[categoryId];
    if (amount === undefined) return;
    saveBudget.mutate([{ categoryId, personId: null, monthlyAmount: amount }]);
    setEdits((e) => { const { [categoryId]: _, ...rest } = e; return rest; });
  };

  return (
    <div className="page col" style={{ gap: 16 }}>
      <Card style={{ padding: "20px 24px" }} className="spread">
        <div>
          <div className="label">Left to budget · {monthLabel(month)}<Tip below text="After-tax income budget minus everything you've allocated to expense categories. Budgets are versioned — edits apply from the current month forward (see History)." /></div>
          <div className="num" style={{ fontSize: 34, fontWeight: 600, marginTop: 4, color: remaining >= 0 ? "var(--accent)" : "var(--danger)" }}>{fmt(remaining)}</div>
        </div>
        <div className="row" style={{ gap: 18 }}>
          <div className="muted" style={{ textAlign: "right", fontSize: 12, lineHeight: 1.8 }}>
            <div>Income <span className="num" style={{ color: "var(--accent)", fontWeight: 600 }}>{fmt(incomeActual)}</span> <span className="num" style={{ opacity: 0.7 }}>/ {fmt(incomeBudget)} budget</span></div>
            <div>Budgeted spending <span className="num" style={{ color: "var(--ink)", fontWeight: 600 }}>{fmt(expenseBudget)}</span></div>
          </div>
          <button className="btn-ghost" onClick={() => setVersionsOpen(true)}>History</button>
          <button className="btn-ghost" style={{ color: "var(--danger)" }} onClick={() => setClearOpen(true)}>Clear budget</button>
        </div>
      </Card>

      <Seg subtle value={tab} onChange={setTab} items={[
        { key: "budget" as Tab, label: "Budget" },
        { key: "inbox" as Tab, label: "Inbox" },
        { key: "manage" as Tab, label: "Manage" },
      ]} />

      {tab === "budget" && excluded.data && (excluded.data.reimbursed.work.spent > 0 || excluded.data.reimbursed.buildings.spent > 0 || excluded.data.goals.length > 0) && (
        <Card style={{ padding: "14px 18px", borderLeft: "3px solid var(--surface-2)" }}>
          <div className="label" style={{ marginBottom: 8 }}>Not counted in this budget · {monthLabel(month)}<Tip text="Spending the budget deliberately ignores: work-reimbursed expenses (with repayments received so far), buildings-covered costs, and transactions tagged to goals — those draw from each goal's own envelope." /></div>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {excluded.data.reimbursed.work.spent > 0 && (
              <span className="chip" style={{ fontSize: 12, padding: "5px 10px" }} title={`repaid so far: ${fmt(excluded.data.reimbursed.work.repaid)}`}>
                💼 work-reimbursed <b className="num">{fmt(excluded.data.reimbursed.work.spent)}</b>
                {excluded.data.reimbursed.work.repaid > 0 && <span className="muted num">· {fmt(excluded.data.reimbursed.work.repaid)} repaid</span>}
              </span>
            )}
            {excluded.data.reimbursed.buildings.spent > 0 && (
              <span className="chip" style={{ fontSize: 12, padding: "5px 10px" }}>
                🏢 buildings <b className="num">{fmt(excluded.data.reimbursed.buildings.spent)}</b>
              </span>
            )}
            {excluded.data.goals.map((g) => (
              <span key={g.goalId} className="chip chip-accent" style={{ fontSize: 12, padding: "5px 10px" }}>
                🎯 {g.name} <b className="num">{fmt(g.spent)}</b>
              </span>
            ))}
          </div>
        </Card>
      )}

      {tab === "budget" && (
        <Card style={{ padding: 8 }}>
          {incomeRows.length > 0 && (
            <>
              <div className="label" style={{ padding: "10px 16px 0" }}>
                Income<Tip text="What actually landed vs the plan. The income budget derives from Settings → Household income (take-home + extra income after tax); categorize deposits as income from the Inbox to fill the bar." />
              </div>
              {incomeRows.map((r) => {
                const fillPct = r.budget > 0 ? Math.min(1, r.actual / r.budget) : r.actual > 0 ? 1 : 0;
                return (
                  <div key={r.categoryId} style={{ padding: "14px 16px", borderRadius: 12 }}>
                    <div className="row" style={{ gap: 14 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="spread" style={{ alignItems: "baseline", marginBottom: 8 }}>
                          <div style={{ fontSize: 13.5, fontWeight: 600 }}>{r.name}</div>
                          <div className="muted num" style={{ fontSize: 12 }}>{fmt(r.actual)} <span style={{ opacity: 0.6 }}>/ {fmt(r.budget)}</span></div>
                        </div>
                        <div className="bar-track">
                          <div className="bar-fill" style={{ width: `${fillPct * 100}%`, background: "var(--accent)" }} />
                        </div>
                      </div>
                      <div className="num" style={{ fontSize: 12, fontWeight: 600, minWidth: 84, textAlign: "right", color: r.variance >= 0 ? "var(--accent)" : "var(--warn)" }}>
                        {r.budget > 0 ? fmtDelta(r.variance) : ""}
                      </div>
                    </div>
                  </div>
                );
              })}
              <div className="label" style={{ padding: "10px 16px 0", borderTop: "1px solid var(--line)" }}>Spending</div>
            </>
          )}
          {topExpense.length === 0 && <EmptyState text="No budget lines yet — set amounts from the category rows or run the setup wizard." />}
          {topExpense.map((r) => {
            const subs = subsOf(r.categoryId);
            // subcategory amounts roll up: the category's shown total is its
            // own budget/actual plus every subcategory's
            const subBudget = subs.reduce((t, s) => t + s.budget, 0);
            const subActual = subs.reduce((t, s) => t + s.actual, 0);
            const budgetTotal = r.budget + subBudget;
            const actualTotal = r.actual + subActual;
            const variance = actualTotal - budgetTotal;
            const over = actualTotal > budgetTotal && budgetTotal > 0;
            const fillPct = budgetTotal > 0 ? Math.min(1, actualTotal / budgetTotal) : actualTotal > 0 ? 1 : 0;
            const dayFraction = view.data?.dayFraction ?? 1;
            const pace = budgetTotal > 0 ? actualTotal / (budgetTotal * dayFraction) : null;
            const isOpen = expanded === r.categoryId;
            const narrative = narrativeFor(r.categoryId);
            const editVal = edits[r.categoryId] ?? r.budget;
            return (
              <div key={r.categoryId} style={{ padding: "14px 16px", borderRadius: 12 }}>
                <div className="row" style={{ gap: 14, cursor: "pointer" }} onClick={() => { setExpanded(isOpen ? null : r.categoryId); setSubDraft(""); }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="spread" style={{ alignItems: "baseline", marginBottom: 8 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600 }}>{r.name}{subs.length > 0 && <span className="muted" style={{ fontSize: 11, fontWeight: 500, marginLeft: 6 }}>{subs.length} sub{subs.length === 1 ? "" : "s"}</span>}</div>
                      <div className="muted num" style={{ fontSize: 12 }}>{fmt(actualTotal)} <span style={{ opacity: 0.6 }}>/ {fmt(budgetTotal)}</span></div>
                    </div>
                    <div className="bar-track">
                      <div className="bar-fill" style={{ width: `${fillPct * 100}%`, background: over ? "var(--warn)" : "var(--accent)" }} />
                    </div>
                  </div>
                  <div className="num" style={{ fontSize: 12, fontWeight: 600, minWidth: 84, textAlign: "right", color: variance > 0 ? "var(--warn)" : "var(--accent)" }}>
                    {budgetTotal > 0 ? fmtDelta(variance) : ""}
                  </div>
                </div>
                {isOpen && (
                  <div style={{ animation: "bb-rowin .2s ease-out" }}>
                    {narrative && narrative.drivers.length > 0 && (
                      <div className="panel muted" style={{ marginTop: 12, fontSize: 12, lineHeight: 1.5, padding: "10px 12px" }}>
                        {narrative.drivers.map((d, i) => <div key={i}>{d.detail} <span className="num" style={{ fontWeight: 600, color: d.delta > 0 ? "var(--warn)" : "var(--accent)" }}>{fmtDelta(d.delta)}</span></div>)}
                      </div>
                    )}
                    <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid var(--line)", display: "grid", gridTemplateColumns: "1fr 190px", gap: 20 }}>
                      <div>
                        <div className="label" style={{ marginBottom: 9 }}>Subcategories<Tip text="Split a category into finer buckets (Insurance → car / life / home). Each subcategory can carry its own monthly budget; rules and AI suggestions can target them directly." /></div>
                        <div className="col" style={{ gap: 10 }}>
                          {subs.map((sub) => (
                            <div key={sub.categoryId} className="row" style={{ gap: 10 }}>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                {renaming === sub.categoryId ? (
                                  <input
                                    className="input" autoFocus
                                    style={{ width: "100%", padding: "2px 6px", fontSize: 12, marginBottom: 4 }}
                                    value={renameDraft}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) => setRenameDraft(e.target.value)}
                                    onBlur={() => commitRename(sub, r.categoryId, r.kind)}
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                                      else if (e.key === "Escape") setRenaming(null);
                                    }}
                                  />
                                ) : (
                                  <div className="row" style={{ gap: 6, marginBottom: 4 }}>
                                    <span style={{ fontSize: 12 }}>{sub.name}</span>
                                    <span className="link" style={{ fontSize: 10.5 }} title="rename subcategory"
                                      onClick={(e) => { e.stopPropagation(); setRenaming(sub.categoryId); setRenameDraft(sub.name); }}>edit</span>
                                  </div>
                                )}
                                <div className="bar-track" style={{ height: 6 }}>
                                  <div className="bar-fill" style={{ width: `${(sub.budget > 0 ? Math.min(1, sub.actual / sub.budget) : sub.actual > 0 ? 1 : 0) * 100}%`, background: "var(--accent)" }} />
                                </div>
                              </div>
                              <div className="num" style={{ fontSize: 12, fontWeight: 600, minWidth: 58, textAlign: "right" }}>{fmt(sub.actual)}</div>
                              <input
                                className="input num" type="number" min={0} step={10}
                                title="monthly budget for this subcategory"
                                style={{ width: 74, padding: "4px 8px", fontSize: 12, textAlign: "right" }}
                                value={edits[sub.categoryId] ?? sub.budget}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => setEdits((s) => ({ ...s, [sub.categoryId]: Number(e.target.value) }))}
                                onBlur={() => commitEdit(sub.categoryId)}
                                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                              />
                            </div>
                          ))}
                          {subs.length === 0 && <div className="muted" style={{ fontSize: 12 }}>No subcategories</div>}
                          <div className="row" style={{ gap: 8 }} onClick={(e) => e.stopPropagation()}>
                            <input className="input" placeholder="add subcategory… (e.g. Car insurance)" value={subDraft}
                              style={{ flex: 1, padding: "6px 10px", fontSize: 12 }}
                              onChange={(e) => setSubDraft(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && subDraft.trim()) {
                                  addSubcategory.mutate({ parentId: r.categoryId, name: subDraft.trim(), kind: r.kind });
                                  setSubDraft("");
                                }
                              }} />
                            <button className="btn-ghost" disabled={!subDraft.trim()}
                              onClick={() => { addSubcategory.mutate({ parentId: r.categoryId, name: subDraft.trim(), kind: r.kind }); setSubDraft(""); }}>
                              + Add
                            </button>
                          </div>
                        </div>
                      </div>
                      <div>
                        <div className="label" style={{ marginBottom: 8 }}>{subs.length > 0 ? "This category" : "Set budget"}{subs.length > 0 && <Tip text="The amount budgeted for spending charged directly to this category — its subcategories are budgeted separately and add on top." />}</div>
                        <input type="range" min={0} max={Math.max(4000, r.budget * 2)} step={20} value={editVal}
                          onChange={(e) => setEdits((s) => ({ ...s, [r.categoryId]: Number(e.target.value) }))}
                          onMouseUp={() => commitEdit(r.categoryId)}
                          onTouchEnd={() => commitEdit(r.categoryId)}
                          style={{ width: "100%", accentColor: "var(--accent)" }} />
                        <div className="num" style={{ fontSize: 13, fontWeight: 600, color: "var(--accent)", textAlign: "center", marginTop: 4 }}>{fmt(editVal)} / mo</div>
                        {subBudget > 0 && (
                          <div className="muted" style={{ fontSize: 11, textAlign: "center", marginTop: 6, lineHeight: 1.5 }}>
                            + {fmt(subBudget)} from {subs.length} subcategor{subs.length === 1 ? "y" : "ies"}<br />
                            = <b className="num" style={{ color: "var(--ink)" }}>{fmt(budgetTotal)}</b> total
                          </div>
                        )}
                        {pace !== null && pace > 1 && <div className="muted" style={{ fontSize: 11, textAlign: "center", marginTop: 6, color: "var(--warn)" }}>pacing {Math.round(pace * 100)}% of budget</div>}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </Card>
      )}

      {tab === "inbox" && <Inbox categories={categories.data?.categories ?? []} />}
      {tab === "manage" && <Manage categories={categories.data?.categories ?? []} />}

      {clearOpen && (
        <Modal title="Clear the budget?" onClose={() => setClearOpen(false)}>
          <div className="col" style={{ gap: 14 }}>
            <div style={{ fontSize: 13, lineHeight: 1.6 }}>
              This wipes every budget amount from <b>{monthLabel(month)}</b> onward so you can build a fresh one —
              set new amounts from the category rows below afterwards.
            </div>
            <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
              Budgets are versioned: past months keep the budget they had, and the cleared version shows up in History.
              Income keeps deriving from Settings → Household income.
            </div>
            <div className="row" style={{ gap: 10, justifyContent: "flex-end" }}>
              <button className="btn-ghost" onClick={() => setClearOpen(false)}>Cancel</button>
              <button className="btn" style={{ background: "var(--danger)" }} disabled={clearBudget.isPending}
                onClick={() => { clearBudget.mutate(); setClearOpen(false); }}>
                Clear from {monthLabel(month)}
              </button>
            </div>
          </div>
        </Modal>
      )}

      {versionsOpen && (
        <Modal title="Budget versions" onClose={() => setVersionsOpen(false)}>
          <div className="col" style={{ gap: 8 }}>
            {(versions.data?.versions ?? []).map((v) => (
              <div key={v.version_id} className="panel spread" style={{ padding: "10px 14px" }}>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{v.name}</div>
                  <div className="muted" style={{ fontSize: 11.5 }}>effective {monthLabel(v.effective_from)}</div>
                </div>
                <div className="muted num" style={{ fontSize: 11.5 }}>{v.created_at.slice(0, 10)}</div>
              </div>
            ))}
            {versions.data?.versions.length === 0 && <div className="empty">No versions yet</div>}
          </div>
        </Modal>
      )}
    </div>
  );
}

function Inbox({ categories }: { categories: Category[] }) {
  const inbox = useApi<{ count: number; cards: InboxCard[] }>(["categories.inbox"], "/api/categories/inbox?limit=25");
  const goals = useApi<GoalsView>(["goals.view", "combined"], "/api/goals");
  const aiStatus = useApi<AiStatus>(["ai.status"], "/api/ai/status");
  const [makeRule, setMakeRule] = useState(false);
  const [aiMode, setAiMode] = useState(false);
  const [ai, setAi] = useState<AiReviewCard | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiNotice, setAiNotice] = useState<string | null>(null);
  const flag = useAction(
    (args: { transactionId: string; flags: { reimbursedBy?: "work" | "buildings" | null; goalId?: string | null; goalLineId?: string | null } }) =>
      api(`/api/transactions/${args.transactionId}/flags`, { method: "PATCH", json: args.flags }),
    ["categories", "cashflow", "budget", "overview", "goals"],
  );
  const categorize = useAction(
    async (args: { transactionId: string; categoryId: string | null; merchant: string | null }) => {
      await api(`/api/transactions/${args.transactionId}/categorize`, { method: "POST", json: { categoryId: args.categoryId } });
      if (makeRule && args.categoryId && args.merchant) {
        await api("/api/categories/rules", {
          method: "POST",
          json: { priority: 100, merchantPattern: args.merchant, categoryId: args.categoryId, retroactiveMonths: 12 },
        });
      }
    },
    ["categories", "cashflow", "budget", "overview"],
  );

  const card = inbox.data?.cards[0];

  // picking a category that has subcategories expands it first — the user can
  // still leave the transaction at the parent level
  const [expandedParent, setExpandedParent] = useState<string | null>(null);
  // transfer / recurring flag state, reset per card
  const [flowNotice, setFlowNotice] = useState<string | null>(null);
  const [recOpen, setRecOpen] = useState(false);
  const [recFreq, setRecFreq] = useState<Frequency>("monthly");
  useEffect(() => {
    setExpandedParent(null);
    setRecOpen(false);
    setRecFreq("monthly");
  }, [card?.transaction.transactionId]);
  const childrenOf = (id: string) => categories.filter((c) => c.parent_id === id && !c.archived);

  // preemptive transfer mark: the card leaves the inbox now; the system pairs
  // it with the counterpart leg within the 8-day window (or alerts if none)
  const markTransfer = useAction(
    (transactionId: string) =>
      api<TransferMarkResult>(`/api/transactions/${transactionId}/transfer`, { method: "POST" }),
    ["categories", "cashflow", "budget", "overview", "alerts"],
  );
  const flagRecurring = useAction(
    (args: { transactionId: string; frequency: Frequency }) =>
      api<RecurringFlagResult>(`/api/transactions/${args.transactionId}/recurring`, {
        method: "POST",
        json: { frequency: args.frequency },
      }),
    ["bills", "overview"],
  );

  const fetchSuggestion = (transactionId: string) => {
    setAiLoading(true);
    setAiError(null);
    api<AiReviewCard | { done: true }>("/api/ai/suggest", { method: "POST", json: { transactionId } })
      .then((r) => { if (!("done" in r)) setAi(r); })
      .catch((e) => setAiError(e instanceof Error ? e.message : String(e)))
      .finally(() => setAiLoading(false));
  };

  // AI review mode: as each unclassified expense surfaces, ask Gemini —
  // one transaction at a time, in inbox order.
  useEffect(() => {
    if (!aiMode || !card || aiLoading) return;
    if (ai?.transaction.transactionId === card.transaction.transactionId) return;
    fetchSuggestion(card.transaction.transactionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiMode, card?.transaction.transactionId]);

  const applyAi = useAction(
    async (a: { transactionId: string; merchant: string | null; s: AiReviewCard["suggestion"]; createSub: boolean }) => {
      let categoryId = a.s.categoryId;
      if (a.createSub && a.s.newSubcategoryName && a.s.newSubcategoryParentId) {
        const parent = categories.find((c) => c.category_id === a.s.newSubcategoryParentId);
        const id = subcategoryId(a.s.newSubcategoryParentId, a.s.newSubcategoryName);
        await api("/api/categories", {
          method: "POST",
          json: { categoryId: id, parentId: a.s.newSubcategoryParentId, name: a.s.newSubcategoryName, kind: parent?.kind ?? "expense" },
        });
        categoryId = id;
      }
      const target = a.s.target === "goal" ? "goal" : "budget";
      const result = await api<AiApplyResult>("/api/ai/apply", {
        method: "POST",
        json: {
          transactionId: a.transactionId,
          target,
          categoryId: target === "budget" ? categoryId : null,
          goalId: target === "goal" ? a.s.goalId : null,
          goalLineId: target === "goal" ? a.s.goalLineId : null,
          lock: !a.s.alwaysAsk,
          merchantPattern: a.merchant,
        },
      });
      setAi(null);
      setAiNotice(result.locked ? "🔒 Mapping locked — future transactions from this merchant map automatically." : result.lockedReason ? `✈️ ${result.lockedReason}` : null);
    },
    ["categories", "cashflow", "budget", "overview", "goals"],
  );

  const catLabel = (id: string | null) => {
    const c = categories.find((x) => x.category_id === id);
    if (!c) return id ?? "?";
    const parent = c.parent_id ? categories.find((x) => x.category_id === c.parent_id) : null;
    return parent ? `${parent.name} → ${c.name}` : c.name;
  };
  const goalLabel = (goalId: string | null, lineId: string | null) => {
    const g = goals.data?.goals.find((x) => x.goal_id === goalId);
    if (!g) return goalId ?? "?";
    const li = lineId ? g.lineItems.find((x) => x.line_id === lineId) : null;
    return li ? `${g.name} → ${li.name}` : g.name;
  };

  // every top-level budget category is offered; the history/AI suggestion is
  // floated to the front. deposits (money in) lead with income targets — a
  // deposit can also be a refund, so expense tops follow; money out sticks to
  // expense categories.
  const options = useMemo(() => {
    if (!card) return [];
    const deposit = card.transaction.amount > 0; // signed flow: positive = money in
    const income = categories.filter((c) => c.kind === "income" && !c.archived);
    const expenseTops = categories.filter((c) => c.parent_id === null && c.kind === "expense" && !c.archived);
    const pool = deposit ? [...income, ...expenseTops] : expenseTops;
    const suggested = pool.find((c) => c.category_id === card.suggestedCategoryId);
    const rest = pool.filter((c) => c.category_id !== suggested?.category_id);
    return suggested ? [suggested, ...rest] : pool;
  }, [categories, card]);

  if (!inbox.data) return <Card><div className="empty">Loading…</div></Card>;
  if (!card) return <Card><EmptyState text="Inbox zero — every transaction is categorized. ✨" /></Card>;

  return (
    <Card style={{ maxWidth: 560, alignSelf: "center", width: "100%", padding: 28 }}>
      <div className="spread">
        <div className="label">Uncategorized · {inbox.data.count} left</div>
        <div className="row" style={{ gap: 10 }}>
          {aiStatus.data?.enabled && (
            <button className={aiMode ? "btn" : "btn-ghost"} style={{ fontSize: 12, padding: "5px 10px" }}
              onClick={() => { setAiMode(!aiMode); if (aiMode) setAi(null); }}
              title={`Gemini (${aiStatus.data.model}) reviews each expense one at a time and proposes a budget category or goal`}>
              ✨ AI review {aiMode ? "on" : "off"}
            </button>
          )}
          <label className="row muted" style={{ fontSize: 12, gap: 6, cursor: "pointer" }}>
            <input type="checkbox" checked={makeRule} onChange={(e) => setMakeRule(e.target.checked)} style={{ accentColor: "var(--accent)" }} />
            always do this (creates a rule)
          </label>
        </div>
      </div>
      {aiNotice && (
        <div className="panel muted" style={{ marginTop: 10, fontSize: 12, padding: "8px 12px" }}>
          {aiNotice} <span className="link" style={{ marginLeft: 6 }} onClick={() => setAiNotice(null)}>dismiss</span>
        </div>
      )}
      {flowNotice && (
        <div className="panel muted" style={{ marginTop: 10, fontSize: 12, padding: "8px 12px", lineHeight: 1.5 }}>
          {flowNotice} <span className="link" style={{ marginLeft: 6 }} onClick={() => setFlowNotice(null)}>dismiss</span>
        </div>
      )}
      <div style={{ textAlign: "center", padding: "26px 0 20px", animation: "bb-popin .2s ease-out" }} key={card.transaction.transactionId}>
        <div style={{ fontSize: 22, fontWeight: 600 }}>{card.transaction.merchant ?? "Unknown merchant"}</div>
        <div className="num" style={{ fontSize: 30, fontWeight: 600, marginTop: 8, color: card.transaction.amount > 0 ? "var(--accent)" : "var(--ink)" }}>
          {fmt(Math.abs(card.transaction.amount))}
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {dayLabel(card.transaction.date)}
          {card.transaction.amount > 0 && <span className="chip chip-accent" style={{ marginLeft: 8 }}>↓ money in</span>}
          {card.transaction.plaidPrimary && <span className="chip" style={{ marginLeft: 8 }}>{card.transaction.plaidPrimary.toLowerCase().replace(/_/g, " ")}</span>}
        </div>
      </div>

      {aiStatus.data?.enabled && (
        <div style={{ marginBottom: 14 }}>
          {aiLoading && <div className="panel muted" style={{ fontSize: 12, padding: "10px 12px" }}>✨ Gemini is reviewing this expense…</div>}
          {aiError && <div className="panel" style={{ fontSize: 12, padding: "10px 12px", color: "var(--danger)" }}>AI review failed: {aiError}</div>}
          {!aiLoading && !ai && !aiMode && (
            <button className="btn-ghost" style={{ width: "100%", justifyContent: "center" }}
              onClick={() => fetchSuggestion(card.transaction.transactionId)}>
              ✨ Ask AI where this belongs
            </button>
          )}
          {ai && ai.transaction.transactionId === card.transaction.transactionId && (
            <div className="panel" style={{ padding: "12px 14px", border: "1px solid var(--accent)", animation: "bb-popin .2s ease-out" }}>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                <span className="label">✨ AI suggests</span>
                {ai.suggestion.target === "budget" && <span className="chip chip-accent">{catLabel(ai.suggestion.categoryId)}</span>}
                {ai.suggestion.target === "goal" && <span className="chip chip-accent">🎯 {goalLabel(ai.suggestion.goalId, ai.suggestion.goalLineId)}</span>}
                {ai.suggestion.target === "unknown" && <span className="chip">not sure — pick manually below</span>}
                <span className="muted num" style={{ fontSize: 11 }}>{Math.round(ai.suggestion.confidence * 100)}%</span>
              </div>
              <div className="muted" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>{ai.suggestion.reason}</div>
              <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
                {ai.suggestion.alwaysAsk
                  ? "✈️ Airline / travel booking — this merchant is asked about every time, the mapping is never locked."
                  : ai.suggestion.target !== "unknown" && "🔒 Accepting locks this mapping: future transactions from this merchant map automatically."}
              </div>
              {ai.suggestion.target !== "unknown" && (
                <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                  <button className="btn" disabled={applyAi.isPending}
                    onClick={() => applyAi.mutate({ transactionId: card.transaction.transactionId, merchant: card.transaction.merchant, s: ai.suggestion, createSub: false })}>
                    Accept
                  </button>
                  {ai.suggestion.newSubcategoryName && ai.suggestion.newSubcategoryParentId && ai.suggestion.target === "budget" && (
                    <button className="btn-ghost" disabled={applyAi.isPending}
                      onClick={() => applyAi.mutate({ transactionId: card.transaction.transactionId, merchant: card.transaction.merchant, s: ai.suggestion, createSub: true })}>
                      Create “{ai.suggestion.newSubcategoryName}” &amp; accept
                    </button>
                  )}
                  <button className="btn-ghost" onClick={() => setAi(null)}>Dismiss</button>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {expandedParent ? (
        <div className="col" style={{ gap: 8, animation: "bb-popin .16s ease-out" }}>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn-ghost" style={{ padding: "5px 10px" }} onClick={() => setExpandedParent(null)}>←</button>
            <span className="label">{catLabel(expandedParent)} — pick a subcategory, or keep it general</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
            <button className="btn" style={{ justifyContent: "center" }}
              onClick={() => categorize.mutate({ transactionId: card.transaction.transactionId, categoryId: expandedParent, merchant: card.transaction.merchant })}>
              Keep in {catLabel(expandedParent)}
            </button>
            {childrenOf(expandedParent).map((sub) => (
              <button key={sub.category_id} className="btn-ghost" style={{ justifyContent: "center" }}
                onClick={() => categorize.mutate({ transactionId: card.transaction.transactionId, categoryId: sub.category_id, merchant: card.transaction.merchant })}>
                {sub.name}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
          {options.map((c, i) => {
            const subs = childrenOf(c.category_id);
            return (
              <button key={c.category_id}
                className={i === 0 && card.suggestedCategoryId === c.category_id ? "btn" : "btn-ghost"}
                style={{ justifyContent: "center" }}
                title={subs.length > 0 ? `${c.name} has ${subs.length} subcategor${subs.length === 1 ? "y" : "ies"} — click to choose` : undefined}
                onClick={() =>
                  subs.length > 0
                    ? setExpandedParent(c.category_id)
                    : categorize.mutate({ transactionId: card.transaction.transactionId, categoryId: c.category_id, merchant: card.transaction.merchant })
                }>
                {c.name}{subs.length > 0 && <span className="muted" style={{ marginLeft: 5, fontSize: 10 }}>▾</span>}
              </button>
            );
          })}
        </div>
      )}
      <div style={{ display: "grid", marginTop: 8 }}>
        <button className="btn-ghost" style={{ justifyContent: "center" }} disabled={markTransfer.isPending}
          title="Not income or spending — money moved to another of your own accounts. Leaves the budget now; validated when the matching leg appears within 8 days."
          onClick={() =>
            markTransfer.mutate(card.transaction.transactionId, {
              onSuccess: (r) =>
                setFlowNotice(
                  r.matched
                    ? "⇄ Transfer validated — the matching leg was already synced, both sides are paired."
                    : "⇄ Marked as a transfer (pending) — it left the budget now; the system watches 8 days for the matching leg and alerts if none appears.",
                ),
            })
          }>
          ⇄ Transfer to another account
        </button>
      </div>
      {recOpen ? (
        <div className="panel" style={{ marginTop: 10, padding: "10px 12px", animation: "bb-popin .16s ease-out" }}>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <span className="label">🔁 Track "{card.transaction.merchant ?? "this charge"}" as recurring</span>
            <select className="input" style={{ width: "auto", padding: "5px 8px", fontSize: 12 }} value={recFreq}
              onChange={(e) => setRecFreq(e.target.value as Frequency)}>
              {(["weekly", "biweekly", "monthly", "quarterly", "semiannual", "annual"] as Frequency[]).map((f) => (
                <option key={f} value={f}>{f}</option>
              ))}
            </select>
            <button className="btn" style={{ padding: "6px 12px" }} disabled={flagRecurring.isPending}
              onClick={() =>
                flagRecurring.mutate(
                  { transactionId: card.transaction.transactionId, frequency: recFreq },
                  {
                    onSuccess: (r) => {
                      setFlowNotice(
                        r.alreadyTracked
                          ? `🔁 "${r.recurring.name}" is already in the bills registry — this charge was linked to it.`
                          : `🔁 Added to Bills as pending — it confirms automatically when the next ${recFreq} charge arrives (still pick a category below).`,
                      );
                      setRecOpen(false);
                    },
                    onError: (e) => setFlowNotice(`🔁 ${e.message}`),
                  },
                )
              }>
              Track
            </button>
            <button className="btn-ghost" onClick={() => setRecOpen(false)}>Cancel</button>
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>
            Lands in Bills as “awaiting confirmation”. Auto-detection keeps running for everything you don't flag.
          </div>
        </div>
      ) : (
        card.transaction.amount < 0 && (
          <div style={{ display: "grid", marginTop: 8 }}>
            <button className="btn-ghost" style={{ justifyContent: "center" }}
              title="Flag this as a repeating expense — it's added to the bills registry as pending and confirms itself when the next charge arrives"
              onClick={() => setRecOpen(true)}>
              🔁 This is a recurring expense…
            </button>
          </div>
        )
      )}
      <div className="row" style={{ gap: 8, marginTop: 14, paddingTop: 12, borderTop: "1px solid var(--line)" }}>
        <span className="muted" style={{ fontSize: 11.5 }}>Not household spending?</span>
        <button className="btn-ghost" onClick={() => flag.mutate({ transactionId: card.transaction.transactionId, flags: { reimbursedBy: "work" } })}>
          💼 Work reimburses
        </button>
        <select className="input" style={{ width: "auto", padding: "7px 10px" }} value=""
          onChange={(e) => {
            if (!e.target.value) return;
            const [goalId, lineId] = e.target.value.split("|");
            flag.mutate({ transactionId: card.transaction.transactionId, flags: { goalId, goalLineId: lineId || null } });
          }}>
          <option value="">🎯 Goal spending…</option>
          {(goals.data?.goals ?? []).map((g) => (
            <optgroup key={g.goal_id} label={g.name}>
              <option value={g.goal_id}>{g.name} (general)</option>
              {g.lineItems.filter((li) => li.status !== "cancelled").map((li) => (
                <option key={li.line_id} value={`${g.goal_id}|${li.line_id}`}>{g.name} → {li.name}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      <div className="muted" style={{ fontSize: 11, marginTop: 8, lineHeight: 1.5 }}>
        Flagged transactions leave the budget entirely — the expense AND the matching repayment deposit. Use "Work reimburses" on both sides of an expense report.
      </div>
    </Card>
  );
}

function Manage({ categories }: { categories: Category[] }) {
  const rules = useApi<{ rules: Rule[] }>(["categories.rules"], "/api/categories/rules");
  const goals = useApi<GoalsView>(["goals.view", "combined"], "/api/goals");
  const [draft, setDraft] = useState<{ pattern: string; categoryId: string } | null>(null);
  const addRule = useAction(
    (d: { pattern: string; categoryId: string }) =>
      api("/api/categories/rules", { method: "POST", json: { priority: 100, merchantPattern: d.pattern, categoryId: d.categoryId, retroactiveMonths: 12 } }),
    ["categories", "cashflow", "budget"],
  );
  const deleteRule = useAction((ruleId: string) => api(`/api/categories/rules/${ruleId}`, { method: "DELETE" }), ["categories"]);
  const catName = (id: string) => categories.find((c) => c.category_id === id)?.name ?? id;
  const targetLabel = (r: Rule) => {
    if (r.category_id) return catName(r.category_id);
    const g = goals.data?.goals.find((x) => x.goal_id === r.goal_id);
    if (!g) return r.goal_id ?? "—";
    const li = r.goal_line_id ? g.lineItems.find((x) => x.line_id === r.goal_line_id) : null;
    return `🎯 ${g.name}${li ? ` → ${li.name}` : ""}`;
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <Card style={{ padding: "8px 8px 12px" }}>
        <div className="spread" style={{ padding: "12px 16px 8px" }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Auto-categorize rules</div>
          <button className="btn-ghost" onClick={() => setDraft({ pattern: "", categoryId: categories.find((c) => c.kind === "expense")?.category_id ?? "" })}>+ Add rule</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "40px 1fr 1fr 40px", gap: 12, padding: "4px 16px 8px" }} className="tablehead">
          <div>#</div><div>Merchant pattern</div><div>Category</div><div />
        </div>
        {(rules.data?.rules ?? []).map((r) => (
          <div key={r.rule_id} className="hoverable" style={{ display: "grid", gridTemplateColumns: "40px 1fr 1fr 40px", gap: 12, padding: "11px 16px", alignItems: "center" }}>
            <div className="muted num" style={{ fontSize: 12, fontWeight: 700 }}>{r.priority}</div>
            <div style={{ fontSize: 12.5, fontWeight: 600, fontFamily: "ui-monospace,monospace" }}>{r.merchant_pattern ?? r.payee_pattern ?? r.plaid_category ?? "—"}</div>
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              <span className="chip chip-accent">{targetLabel(r)}</span>
              {r.locked_at && <span className="chip" title={`Locked ${r.locked_at.slice(0, 10)} — applies to all future transactions; delete to change`}>🔒</span>}
              {r.source === "ai" && <span className="chip" title="Created from an accepted AI suggestion" style={{ fontSize: 10.5 }}>✨ ai</span>}
            </div>
            <div style={{ cursor: "pointer", color: "var(--ink-muted)", textAlign: "center" }} title={r.locked_at ? "delete locked mapping" : "delete rule"} onClick={() => deleteRule.mutate(r.rule_id)}>×</div>
          </div>
        ))}
        {rules.data?.rules.length === 0 && <div className="empty">No rules yet — create them from the inbox's "always do this" toggle.</div>}
      </Card>

      <Card style={{ padding: "8px 8px 12px" }}>
        <div style={{ padding: "12px 16px 8px", fontSize: 14, fontWeight: 600 }}>Categories</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: "4px 16px 12px" }}>
          {categories.filter((c) => c.parent_id === null && !c.archived).map((c) => (
            <span key={c.category_id} className="chip" style={{ fontSize: 12, padding: "5px 10px" }}>
              {c.name}
              <span className="muted" style={{ fontSize: 10 }}>{categories.filter((x) => x.parent_id === c.category_id).length || ""}</span>
            </span>
          ))}
        </div>
      </Card>

      {draft && (
        <Modal title="New rule" onClose={() => setDraft(null)}>
          <div className="col" style={{ gap: 14 }}>
            <Field label="Merchant pattern" hint="substring match against the merchant name">
              <input className="input" value={draft.pattern} onChange={(e) => setDraft({ ...draft, pattern: e.target.value })} placeholder="e.g. COSTCO" />
            </Field>
            <Field label="Category">
              <select className="input" value={draft.categoryId} onChange={(e) => setDraft({ ...draft, categoryId: e.target.value })}>
                {categories.filter((c) => !c.archived).map((c) => <option key={c.category_id} value={c.category_id}>{c.name}</option>)}
              </select>
            </Field>
            <button className="btn" disabled={!draft.pattern || !draft.categoryId} onClick={() => { addRule.mutate(draft); setDraft(null); }}>
              Save rule (re-tags last 12 months)
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
