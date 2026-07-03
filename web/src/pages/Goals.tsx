import { useMemo, useRef, useState } from "react";
import { useAction, useApi, useCtx, usePersons } from "../api/hooks";
import { api } from "../api/client";
import type { Goal, GoalsView, PlanRow, PlanLine, Scenario, SolveResult } from "../api/types";
import { Card, EmptyState, Feasibility, Field, Modal, Ring } from "../components/ui";
import { Tip } from "../components/Tip";
import { fmt, monthLabel } from "../lib/format";

const GOAL_TYPES = ["house", "kid", "trip", "purchase", "savings", "event", "emergency_fund", "debt_payoff"] as const;

interface GoalDraft { name: string; goalType: (typeof GOAL_TYPES)[number]; targetAmount: number; targetDate: string | null; priority: number; personId: string | null }

/** Shared create-goal form (also used by onboarding). */
export function GoalForm({ onSubmit, submitLabel }: { onSubmit: (d: GoalDraft) => void; submitLabel: string }) {
  const persons = usePersons();
  const [d, setD] = useState<GoalDraft>({ name: "", goalType: "savings", targetAmount: 0, targetDate: null, priority: 3, personId: null });
  return (
    <div className="col" style={{ gap: 13 }}>
      <Field label="Name"><input className="input" value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="e.g. House down payment" /></Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Type">
          <select className="input" value={d.goalType} onChange={(e) => setD({ ...d, goalType: e.target.value as GoalDraft["goalType"] })}>
            {GOAL_TYPES.map((t) => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
          </select>
        </Field>
        <Field label="Target amount"><input className="input num" type="number" min={0} value={d.targetAmount || ""} onChange={(e) => setD({ ...d, targetAmount: Number(e.target.value) })} /></Field>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <Field label="Target date"><input className="input" type="date" value={d.targetDate ?? ""} onChange={(e) => setD({ ...d, targetDate: e.target.value || null })} /></Field>
        <Field label="Priority (1 = highest)"><input className="input num" type="number" min={1} max={5} value={d.priority} onChange={(e) => setD({ ...d, priority: Number(e.target.value) })} /></Field>
        <Field label="Whose?">
          <select className="input" value={d.personId ?? ""} onChange={(e) => setD({ ...d, personId: e.target.value || null })}>
            <option value="">Joint</option>
            {(persons.data?.persons ?? []).map((p) => <option key={p.person_id} value={p.person_id}>{p.display_name}</option>)}
          </select>
        </Field>
      </div>
      <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
        The target doubles as the goal's own budget: transactions you tag to this goal (from the Budget inbox) are excluded from the monthly household budget and tracked here instead.
      </div>
      <button className="btn" disabled={!d.name || !d.targetAmount} onClick={() => onSubmit(d)}>{submitLabel}</button>
    </div>
  );
}

function monthsFromNow(date: string): number {
  const now = new Date();
  const d = new Date(date + "T00:00:00");
  return (d.getFullYear() - now.getFullYear()) * 12 + d.getMonth() - now.getMonth();
}

function dateFromMonths(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() + months, 15);
  return d.toISOString().slice(0, 10);
}

const HORIZON = 60; // now → +5y

export function Goals() {
  const { lens, month, q } = useCtx();
  const view = useApi<GoalsView>(["goals.view", lens, month], `/api/goals${q}`);
  const activePlan = useApi<{ plan: PlanRow | null; lines: PlanLine[] }>(["plans.active"], "/api/plans/active");
  const scenarios = useApi<{ scenarios: Scenario[] }>(["scenarios"], "/api/scenarios");

  const [shifts, setShifts] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<SolveResult | null>(null);
  const [creating, setCreating] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [compareId, setCompareId] = useState<string | null>(null);
  const inflight = useRef(false);
  const pendingBody = useRef<object | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  const createGoal = useAction((d: GoalDraft) => api("/api/goals", { method: "POST", json: d }), ["goals", "overview", "plans"]);
  const patchGoal = useAction((a: { goalId: string; patch: object }) => api(`/api/goals/${a.goalId}`, { method: "PATCH", json: a.patch }), ["goals", "overview", "plans"]);
  const addItem = useAction((a: { goalId: string; name: string; amount: number }) => api(`/api/goals/${a.goalId}/items`, { method: "POST", json: { name: a.name, amount: a.amount } }), ["goals"]);
  const removeItem = useAction((lineId: string) => api(`/api/goals/items/${lineId}`, { method: "DELETE" }), ["goals"]);
  const approve = useAction(
    () => api("/api/plans/approve", { method: "POST", json: { name: `Plan ${month}`, overrides: shiftsBody() } }),
    ["plans", "goals", "overview"],
  );
  const addScenario = useAction((s: { name: string; params: object }) => api("/api/scenarios", { method: "POST", json: { name: s.name, params: s.params } }), ["scenarios"]);
  const removeScenario = useAction((id: string) => api(`/api/scenarios/${id}`, { method: "DELETE" }), ["scenarios"]);
  const compare = useApi<SolveResult>(["scenarios.solve", compareId ?? ""], null); // populated below via manual fetch
  const [compareResult, setCompareResult] = useState<SolveResult | null>(null);
  void compare;

  const shiftsBody = () => ({ goalShifts: Object.entries(shifts).map(([goalId, targetDate]) => ({ goalId, targetDate })) });

  /** drop-stale throttle for the drag-to-replan hot path */
  const runPreview = (body: object) => {
    if (inflight.current) { pendingBody.current = body; return; }
    inflight.current = true;
    api<SolveResult>(`/api/goals/solve/preview${q}`, { method: "POST", json: body })
      .then((r) => setPreview(r))
      .finally(() => {
        inflight.current = false;
        if (pendingBody.current) { const b = pendingBody.current; pendingBody.current = null; runPreview(b); }
      });
  };

  const onDrag = (goal: Goal, e: React.PointerEvent) => {
    const track = trackRef.current;
    if (!track || !goal.target_date) return;
    e.preventDefault();
    const rect = track.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const frac = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      const m = Math.max(1, Math.round(frac * HORIZON));
      const date = dateFromMonths(m);
      setShifts((s) => {
        const next = { ...s, [goal.goal_id]: date };
        runPreview({ goalShifts: Object.entries(next).map(([goalId, targetDate]) => ({ goalId, targetDate })) });
        return next;
      });
    };
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const solve = preview ?? view.data?.solve ?? null;
  const verdicts = useMemo(() => new Map((solve?.perGoal ?? []).map((v) => [v.goalId, v])), [solve]);
  const goals = view.data?.goals ?? [];
  const dirty = Object.keys(shifts).length > 0;
  const collisions = new Set(solve?.collisions ?? []);
  const detailGoal = goals.find((g) => g.goal_id === detail) ?? null;

  const runCompare = (id: string) => {
    setCompareId(id);
    api<SolveResult>(`/api/scenarios/${id}/solve${q}`, { method: "POST", json: {} }).then(setCompareResult);
  };

  return (
    <div className="page col" style={{ gap: 20 }}>
      <Card>
        <div className="spread" style={{ marginBottom: 6 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Timeline — drag a goal to replan<Tip text="Bar length = time to target date; the fill is funding progress. Drag to move a date and the solver re-runs live — ✓ on track, ~ tight, ✕ not feasible. 'Save as plan' commits the shifted dates." /></div>
            <div className="muted" style={{ fontSize: 12 }}>the solver re-runs live; red months are collisions where demands exceed free cash flow</div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            {dirty && <button className="btn-ghost" onClick={() => { setShifts({}); setPreview(null); }}>Reset</button>}
            {dirty && <button className="btn" onClick={() => { approve.mutate(); setShifts({}); setPreview(null); }}>Save as plan</button>}
            <button className="btn-ghost" onClick={() => setCreating(true)}>+ New goal</button>
          </div>
        </div>
        <div ref={trackRef} style={{ position: "relative", marginTop: 14, borderRadius: 12, background: "var(--surface-2)", padding: "10px 0 6px", minHeight: 60 }}>
          {/* collision shading */}
          {[...collisions].map((m) => {
            const mm = monthsFromNow(m + "-15");
            if (mm < 0 || mm > HORIZON) return null;
            return <div key={m} style={{ position: "absolute", top: 0, bottom: 0, left: `${(mm / HORIZON) * 100}%`, width: `${100 / HORIZON}%`, background: "color-mix(in srgb, var(--danger) 14%, transparent)", borderRadius: 4 }} />;
          })}
          {/* year ticks */}
          {[0, 12, 24, 36, 48, 60].map((m) => (
            <div key={m} className="muted num" style={{ position: "absolute", top: 2, left: `calc(${(m / HORIZON) * 100}% + 4px)`, fontSize: 9.5 }}>
              {m === 0 ? "now" : `+${m / 12}y`}
            </div>
          ))}
          <div className="col" style={{ gap: 8, paddingTop: 16 }}>
            {goals.filter((g) => g.target_date).map((g) => {
              const date = shifts[g.goal_id] ?? g.target_date!;
              const m = Math.max(0.5, Math.min(HORIZON, monthsFromNow(date)));
              const v = verdicts.get(g.goal_id);
              const color = v?.feasible === "no" ? "var(--danger)" : v?.feasible === "tight" ? "var(--warn)" : "var(--accent)";
              return (
                <div key={g.goal_id} style={{ position: "relative", height: 30 }}>
                  <div onPointerDown={(e) => onDrag(g, e)} onClick={() => setDetail(g.goal_id)}
                    style={{ position: "absolute", left: 0, width: `${(m / HORIZON) * 100}%`, height: 28, borderRadius: 8, background: `color-mix(in srgb, ${color} 16%, transparent)`, border: `1px solid ${color}`, cursor: "grab", overflow: "hidden", transition: preview ? "none" : "width .3s" }}>
                    <div style={{ position: "absolute", inset: 0, width: `${g.progress * 100}%`, background: `color-mix(in srgb, ${color} 28%, transparent)` }} />
                    <div className="row" style={{ position: "relative", height: "100%", padding: "0 10px", gap: 8, whiteSpace: "nowrap" }}>
                      <span style={{ fontSize: 12, fontWeight: 600 }}>{g.name}</span>
                      <span className="muted num" style={{ fontSize: 11 }}>{fmt(g.funded_amount)} / {fmt(g.target_amount)}</span>
                      <span className="num" style={{ fontSize: 10.5, color }}>{monthLabel(date.slice(0, 7))}</span>
                    </div>
                  </div>
                </div>
              );
            })}
            {goals.length === 0 && <EmptyState text="No goals yet." action={<button className="btn" onClick={() => setCreating(true)}>Create your first goal</button>} />}
          </div>
        </div>
        {solve && (
          <div className="row" style={{ gap: 10, marginTop: 14, flexWrap: "wrap" }}>
            {solve.perGoal.map((v) => (
              <div key={v.goalId} className="panel row" style={{ padding: "8px 12px", gap: 8 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>{v.name}</span>
                <Feasibility verdict={v.feasible} />
                {v.requiredMonthly !== null && <span className="muted num" style={{ fontSize: 11.5 }}>{fmt(v.requiredMonthly)}/mo</span>}
                {v.gap > 0 && <span className="num" style={{ fontSize: 11.5, color: "var(--danger)" }}>gap {fmt(v.gap)}</span>}
              </div>
            ))}
          </div>
        )}
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 16 }}>
        {goals.map((g) => {
          const v = verdicts.get(g.goal_id);
          const color = v?.feasible === "no" ? "var(--danger)" : v?.feasible === "tight" ? "var(--warn)" : "var(--accent)";
          return (
            <Card key={g.goal_id} style={{ cursor: "pointer" }} onClick={() => setDetail(g.goal_id)}>
              <div className="row" style={{ gap: 14 }}>
                <Ring pct={g.progress} color={color} size={64} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{g.name}</div>
                  <div className="muted num" style={{ fontSize: 12, marginTop: 3 }}>{fmt(g.funded_amount)} of {fmt(g.target_amount)}</div>
                  {g.target_date && <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>by {monthLabel(g.target_date.slice(0, 7))}</div>}
                  {g.requiredMonthly !== null && <div className="num" style={{ fontSize: 12, marginTop: 4, color, fontWeight: 600 }}>{fmt(g.requiredMonthly)}/mo needed</div>}
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      <Card>
        <div className="spread" style={{ marginBottom: 10 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Scenarios<Tip text="Saved what-if worlds (e.g. income drops $800/mo). Click one to solve it and compare per-goal verdicts and funding dates against today's plan, side by side." /></div>
            <div className="muted" style={{ fontSize: 12 }}>compare a what-if world against today's plan{activePlan.data?.plan ? ` · active plan: ${activePlan.data.plan.name}` : ""}</div>
          </div>
          <button className="btn-ghost" onClick={() => {
            const name = window.prompt("Scenario name (e.g. 'Shanthi part-time')");
            if (!name) return;
            const delta = Number(window.prompt("Free cash flow change per month (e.g. -800)") ?? 0);
            addScenario.mutate({ name, params: { freeCashFlowDelta: delta || 0 } });
          }}>+ Scenario</button>
        </div>
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {(scenarios.data?.scenarios ?? []).map((s) => (
            <div key={s.scenario_id} className={`panel row`} style={{ padding: "8px 12px", gap: 8, cursor: "pointer", outline: compareId === s.scenario_id ? "1px solid var(--accent)" : "none" }} onClick={() => runCompare(s.scenario_id)}>
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>{s.name}</span>
              <span style={{ cursor: "pointer", color: "var(--ink-muted)" }} onClick={(e) => { e.stopPropagation(); removeScenario.mutate(s.scenario_id); if (compareId === s.scenario_id) { setCompareId(null); setCompareResult(null); } }}>×</span>
            </div>
          ))}
          {scenarios.data?.scenarios.length === 0 && <span className="muted" style={{ fontSize: 12.5 }}>No scenarios saved.</span>}
        </div>
        {compareResult && view.data && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginTop: 14 }}>
            {[{ title: "Today", r: view.data.solve }, { title: scenarios.data?.scenarios.find((s) => s.scenario_id === compareId)?.name ?? "Scenario", r: compareResult }].map((side) => (
              <div key={side.title} className="panel" style={{ padding: 14 }}>
                <div className="label" style={{ marginBottom: 8 }}>{side.title}</div>
                <div className="col" style={{ gap: 6 }}>
                  {side.r.perGoal.map((v) => (
                    <div key={v.goalId} className="spread" style={{ fontSize: 12.5 }}>
                      <span>{v.name}</span>
                      <span className="row" style={{ gap: 8 }}>
                        <Feasibility verdict={v.feasible} />
                        <span className="muted num">{v.fundedBy ? monthLabel(v.fundedBy) : "—"}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {creating && (
        <Modal title="New goal" onClose={() => setCreating(false)}>
          <GoalForm submitLabel="Create goal" onSubmit={(d) => { createGoal.mutate(d); setCreating(false); }} />
        </Modal>
      )}

      {detailGoal && (
        <Modal title={detailGoal.name} onClose={() => setDetail(null)} width={560}>
          <div className="col" style={{ gap: 14 }}>
            <div className="row" style={{ gap: 16 }}>
              <Ring pct={detailGoal.progress} size={80} />
              <div className="col" style={{ gap: 4, fontSize: 13 }}>
                <div><span className="muted">Funded</span> <b className="num">{fmt(detailGoal.funded_amount)}</b> <span className="muted">of</span> <b className="num">{fmt(detailGoal.target_amount)}</b></div>
                {detailGoal.target_date && <div><span className="muted">Target</span> <b>{monthLabel(detailGoal.target_date.slice(0, 7))}</b></div>}
                <div><span className="muted">Priority</span> <b>{detailGoal.priority}</b> · <span className="muted">type</span> <b>{detailGoal.goal_type.replace(/_/g, " ")}</b></div>
                {detailGoal.taggedSpend.total > 0 && (
                  <div>
                    <span className="muted">Spent against this goal</span>{" "}
                    <b className="num" style={{ color: "var(--warn)" }}>{fmt(detailGoal.taggedSpend.total)}</b>{" "}
                    <span className="muted num">({fmt(detailGoal.taggedSpend.month)} this month · excluded from the budget)</span>
                  </div>
                )}
              </div>
            </div>
            <div>
              <div className="spread" style={{ marginBottom: 8 }}>
                <div className="label">Subcategories<Tip text="Break the goal into envelopes (Japan trip → tickets, hotel, food, activities). Transactions tagged to a subcategory (from the Budget inbox or by an AI mapping) count against its amount." /></div>
                <span className="link" style={{ fontSize: 12 }} onClick={() => {
                  const name = window.prompt("Subcategory name (e.g. Tickets, Hotel, Food, Activities)");
                  const amount = Number(window.prompt("Planned amount") ?? 0);
                  if (name && amount) addItem.mutate({ goalId: detailGoal.goal_id, name, amount });
                }}>+ add subcategory</span>
              </div>
              <div className="col" style={{ gap: 6 }}>
                {detailGoal.lineItems.map((li) => {
                  const pct = li.amount > 0 ? Math.min(1, li.spent / li.amount) : 0;
                  const over = li.spent > li.amount && li.amount > 0;
                  return (
                    <div key={li.line_id} className="panel" style={{ padding: "8px 12px", fontSize: 12.5 }}>
                      <div className="spread">
                        <span>{li.name} <span className="chip" style={{ marginLeft: 6 }}>{li.status.replace(/_/g, " ")}</span></span>
                        <span className="row" style={{ gap: 10 }}>
                          <span className="muted num">{li.spent > 0 && <>{fmt(li.spent)} <span style={{ opacity: 0.6 }}>of</span> </>}<b style={{ color: "var(--ink)" }}>{fmt(li.amount)}</b></span>
                          <span style={{ cursor: "pointer", color: "var(--ink-muted)" }} onClick={() => removeItem.mutate(li.line_id)}>×</span>
                        </span>
                      </div>
                      {li.spent > 0 && (
                        <div className="bar-track" style={{ height: 5, marginTop: 6 }}>
                          <div className="bar-fill" style={{ width: `${pct * 100}%`, background: over ? "var(--warn)" : "var(--accent)" }} />
                        </div>
                      )}
                    </div>
                  );
                })}
                {detailGoal.lineItems.length === 0 && <div className="muted" style={{ fontSize: 12 }}>No subcategories — add tickets / hotel / food / activities to track where the goal's money goes.</div>}
                {detailGoal.eventBudget && (
                  <div className="muted" style={{ fontSize: 12 }}>
                    committed {fmt(detailGoal.eventBudget.committed)} · paid {fmt(detailGoal.eventBudget.paid)} · remaining {fmt(detailGoal.eventBudget.remaining)}
                  </div>
                )}
              </div>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn-ghost" onClick={() => { patchGoal.mutate({ goalId: detailGoal.goal_id, patch: { status: "paused" } }); setDetail(null); }}>Pause</button>
              <button className="btn-ghost" onClick={() => { patchGoal.mutate({ goalId: detailGoal.goal_id, patch: { status: "achieved" } }); setDetail(null); }}>Mark achieved 🎉</button>
              <button className="btn-ghost btn-danger" style={{ background: "var(--danger)", color: "#fff", border: "none" }} onClick={() => { patchGoal.mutate({ goalId: detailGoal.goal_id, patch: { status: "abandoned" } }); setDetail(null); }}>Abandon</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
