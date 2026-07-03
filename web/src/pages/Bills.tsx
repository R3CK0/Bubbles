import { useMemo, useState } from "react";
import { useAction, useApi, useCtx, usePersons } from "../api/hooks";
import { api } from "../api/client";
import type { BillsCalendar, Category, Frequency, RegistryItem } from "../api/types";
import { Card, EmptyState, Field, Modal, Spark } from "../components/ui";
import { Tip } from "../components/Tip";
import { Chart, chartBase, EChartsOption } from "../components/Chart";
import { cssVar, dayLabel, daysUntil, fmt, fmtC, monthLabel } from "../lib/format";
import { useUi } from "../stores/ui";

export const FREQUENCIES: Frequency[] = ["weekly", "biweekly", "monthly", "quarterly", "semiannual", "annual"];

export interface BillDraft {
  rpId?: string;
  name: string;
  expectedAmount: number;
  frequency: Frequency;
  anchorDate: string;
  personId: string | null;
  categoryId: string | null;
  autopay: boolean;
  reimbursedBy: "work" | "buildings" | null;
}

export function billBody(d: BillDraft) {
  return {
    name: d.name, expectedAmount: d.expectedAmount, frequency: d.frequency, anchorDate: d.anchorDate,
    personId: d.personId, categoryId: d.categoryId, autopay: d.autopay, reimbursedBy: d.reimbursedBy,
  };
}

/** Shared bill create/edit form (also used by the onboarding wizard). */
export function BillForm({ draft, setDraft, categories, onSubmit, submitLabel }: {
  draft: BillDraft; setDraft: (d: BillDraft) => void; categories: Category[];
  onSubmit: () => void; submitLabel: string;
}) {
  const persons = usePersons();
  return (
    <div className="col" style={{ gap: 13 }}>
      <Field label="Name"><input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="e.g. Hydro-Québec" /></Field>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Amount"><input className="input num" type="number" min={0} step={0.01} value={draft.expectedAmount || ""} onChange={(e) => setDraft({ ...draft, expectedAmount: Number(e.target.value) })} /></Field>
        <Field label="Frequency">
          <select className="input" value={draft.frequency} onChange={(e) => setDraft({ ...draft, frequency: e.target.value as Frequency })}>
            {FREQUENCIES.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </Field>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <Field label="Next / anchor date"><input className="input" type="date" value={draft.anchorDate} onChange={(e) => setDraft({ ...draft, anchorDate: e.target.value })} /></Field>
        <Field label="Whose is it?">
          <select className="input" value={draft.personId ?? ""} onChange={(e) => setDraft({ ...draft, personId: e.target.value || null })}>
            <option value="">Joint</option>
            {(persons.data?.persons ?? []).map((p) => <option key={p.person_id} value={p.person_id}>{p.display_name}</option>)}
          </select>
        </Field>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, alignItems: "end" }}>
        <Field label="Category">
          <CategorySelect categories={categories} value={draft.categoryId} onChange={(categoryId) => setDraft({ ...draft, categoryId })} allowNone />
        </Field>
        <Field label="Covered by" hint="reimbursed bills never touch the budget — matched payments and repayments are excluded">
          <select className="input" value={draft.reimbursedBy ?? ""} onChange={(e) => setDraft({ ...draft, reimbursedBy: (e.target.value || null) as BillDraft["reimbursedBy"] })}>
            <option value="">Household</option>
            <option value="work">Work reimburses</option>
            <option value="buildings">Buildings</option>
          </select>
        </Field>
      </div>
      <label className="row muted" style={{ fontSize: 12.5, gap: 7, cursor: "pointer" }}>
        <input type="checkbox" checked={draft.autopay} onChange={(e) => setDraft({ ...draft, autopay: e.target.checked })} style={{ accentColor: "var(--accent)" }} /> autopay
      </label>
      <button className="btn" disabled={!draft.name || !draft.expectedAmount || !draft.anchorDate} onClick={onSubmit}>{submitLabel}</button>
    </div>
  );
}

/** Expense-category picker, subcategory-aware: subs are grouped under their parent. */
export function CategorySelect({ categories, value, onChange, allowNone }: {
  categories: Category[]; value: string | null; onChange: (categoryId: string | null) => void; allowNone?: boolean;
}) {
  const expense = categories.filter((c) => c.kind === "expense" && !c.archived);
  const tops = expense.filter((c) => c.parent_id === null);
  const subsOf = (id: string) => expense.filter((c) => c.parent_id === id);
  return (
    <select className="input" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      {allowNone && <option value="">—</option>}
      {tops.map((top) => {
        const subs = subsOf(top.category_id);
        if (subs.length === 0) return <option key={top.category_id} value={top.category_id}>{top.name}</option>;
        return (
          <optgroup key={top.category_id} label={top.name}>
            <option value={top.category_id}>{top.name} (general)</option>
            {subs.map((s) => <option key={s.category_id} value={s.category_id}>{top.name} → {s.name}</option>)}
          </optgroup>
        );
      })}
    </select>
  );
}

export function Bills() {
  const { lens, month, q } = useCtx();
  const theme = useUi((s) => s.theme);
  const calendar = useApi<BillsCalendar>(["bills.calendar", lens, month], `/api/bills/calendar${q}`);
  const active = useApi<{ registry: RegistryItem[] }>(["bills.registry", "active"], "/api/bills/registry?status=active");
  const proposed = useApi<{ registry: RegistryItem[] }>(["bills.registry", "proposed"], "/api/bills/registry?status=proposed");
  const renewals = useApi<{ renewals: RegistryItem[] }>(["bills.renewals"], "/api/bills/renewals?days=60");
  const categories = useApi<{ categories: Category[] }>(["categories"], "/api/categories");
  const [draft, setDraft] = useState<BillDraft | null>(null);
  const [hoverDay, setHoverDay] = useState<string | null>(null);
  const [catEdit, setCatEdit] = useState<{ rpId: string; name: string; categoryId: string | null } | null>(null);
  const [catNotice, setCatNotice] = useState<string | null>(null);

  const save = useAction(
    (d: BillDraft) => d.rpId
      ? api(`/api/bills/${d.rpId}`, { method: "PATCH", json: billBody(d) })
      : api("/api/bills", { method: "POST", json: billBody(d) }),
    ["bills", "overview", "goals"],
  );
  const remove = useAction((rpId: string) => api(`/api/bills/${rpId}`, { method: "DELETE" }), ["bills", "overview"]);
  const saveCategory = useAction(
    async (a: { rpId: string; categoryId: string }) => {
      const r = await api<{ ruleUpdated: boolean; applied: number }>(`/api/bills/${a.rpId}/category`, { method: "POST", json: { categoryId: a.categoryId } });
      setCatNotice(
        r.ruleUpdated
          ? `Merchant mapping retargeted — ${r.applied} past transaction${r.applied === 1 ? "" : "s"} re-categorized.`
          : `New locked mapping created — ${r.applied} past transaction${r.applied === 1 ? "" : "s"} re-categorized.`,
      );
    },
    ["bills", "categories", "budget", "cashflow", "overview"],
  );
  const accept = useAction((rpId: string) => api(`/api/bills/${rpId}/accept`, { method: "POST", json: {} }), ["bills", "overview"]);
  const dismiss = useAction((rpId: string) => api(`/api/bills/${rpId}/dismiss`, { method: "POST", json: {} }), ["bills"]);

  const cal = calendar.data;
  const ribbonOption = useMemo<EChartsOption>(() => {
    if (!cal) return {};
    const base = chartBase(cssVar("--ink"), cssVar("--ink-muted"), cssVar("--line"));
    return {
      ...base,
      xAxis: { type: "category", data: cal.projection.map((p) => p.date.slice(8)), ...base.xAxis },
      yAxis: { type: "value", ...base.yAxis },
      series: [{
        type: "line", data: cal.projection.map((p) => Math.round(p.value)), smooth: 0.25, symbol: "none",
        lineStyle: { color: cssVar("--accent"), width: 2 },
        areaStyle: { color: cssVar("--accent"), opacity: 0.1 },
        markLine: {
          silent: true, symbol: "none",
          data: [{ yAxis: cal.bufferFloor, lineStyle: { color: cssVar("--warn"), type: "dashed" }, label: { formatter: "buffer floor", color: cssVar("--warn"), fontSize: 10 } }],
        },
        markArea: {
          silent: true, itemStyle: { color: cssVar("--warn"), opacity: 0.1 },
          data: cal.lowWindows.map((w) => [{ xAxis: w.start.slice(8) }, { xAxis: w.end.slice(8) }]),
        },
      }],
    };
  }, [cal, theme]);

  const priceCreep = (r: RegistryItem): number | null => {
    if (r.priceHistory.length < 2) return null;
    const delta = r.priceHistory[r.priceHistory.length - 1].amount - r.priceHistory[0].amount;
    return Math.abs(delta) >= 1 ? delta : null;
  };

  const newDraft = (): BillDraft => ({ name: "", expectedAmount: 0, frequency: "monthly", anchorDate: new Date().toISOString().slice(0, 10), personId: null, categoryId: null, autopay: false, reimbursedBy: null });

  const catLabel = (id: string | null): string | null => {
    if (!id) return null;
    const cats = categories.data?.categories ?? [];
    const c = cats.find((x) => x.category_id === id);
    if (!c) return id;
    const parent = c.parent_id ? cats.find((x) => x.category_id === c.parent_id) : null;
    return parent ? `${parent.name} → ${c.name}` : c.name;
  };

  return (
    <div className="page col" style={{ gap: 20 }}>
      {catNotice && (
        <Card style={{ padding: "10px 16px", borderLeft: "3px solid var(--accent)" }}>
          <div className="spread" style={{ fontSize: 12.5 }}>
            <span>🔒 {catNotice}</span>
            <span className="link" onClick={() => setCatNotice(null)}>dismiss</span>
          </div>
        </Card>
      )}
      {(proposed.data?.registry.filter((r) => r.source === "manual").length ?? 0) > 0 && (
        <Card style={{ borderLeft: "3px solid var(--warn)" }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>Flagged from the inbox — awaiting confirmation<Tip text="Bills you flagged while categorizing. Each confirms itself into the registry the moment its next matching charge arrives (within about a week of the expected date). Confirm now to skip the wait, or remove if it was a mistake." /></div>
          <div className="col" style={{ gap: 8 }}>
            {proposed.data!.registry.filter((r) => r.source === "manual").map((r) => (
              <div key={r.rp_id} className="panel spread" style={{ padding: "10px 14px" }}>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{r.name}</span>
                  <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>{fmtC(r.expected_amount)} · {r.frequency}</span>
                  <span className="chip" style={{ marginLeft: 8, background: "color-mix(in srgb, var(--warn) 12%, transparent)", color: "var(--warn)" }}>
                    ⏳ confirms ~{dayLabel(r.next_due_date)}
                  </span>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn" style={{ padding: "6px 12px" }} onClick={() => accept.mutate(r.rp_id)}>Confirm now</button>
                  <button className="btn-ghost" onClick={() => dismiss.mutate(r.rp_id)}>Remove</button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
      {(proposed.data?.registry.filter((r) => r.source === "detected").length ?? 0) > 0 && (
        <Card style={{ borderLeft: "3px solid var(--accent)" }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>Detected in your transactions — track these?<Tip text="The nightly job spots repeating charges (same merchant, similar amount, regular cadence). Accept to add one to the registry; dismiss to never see it again." /></div>
          <div className="col" style={{ gap: 8 }}>
            {proposed.data!.registry.filter((r) => r.source === "detected").map((r) => (
              <div key={r.rp_id} className="panel spread" style={{ padding: "10px 14px" }}>
                <div>
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{r.name}</span>
                  <span className="muted" style={{ fontSize: 12, marginLeft: 8 }}>{fmtC(r.expected_amount)} · {r.frequency}</span>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button className="btn" style={{ padding: "6px 12px" }} onClick={() => accept.mutate(r.rp_id)}>Accept</button>
                  <button className="btn-ghost" onClick={() => dismiss.mutate(r.rp_id)}>Dismiss</button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "360px minmax(0,1fr)", gap: 20 }}>
        <Card>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>{monthLabel(month)}</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 4 }}>
            {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <div key={i} className="muted" style={{ textAlign: "center", fontSize: 10, fontWeight: 700 }}>{d}</div>)}
            {cal && (() => {
              const first = new Date(month + "-01T00:00:00");
              const pad = first.getDay();
              const byDate = new Map(cal.days.map((d) => [d.date, d]));
              const lowSet = new Set<string>();
              for (const w of cal.lowWindows) for (let d = new Date(w.start + "T00:00:00"); d <= new Date(w.end + "T00:00:00"); d.setDate(d.getDate() + 1)) lowSet.add(d.toISOString().slice(0, 10));
              return [
                ...Array.from({ length: pad }, (_, i) => <div key={`p${i}`} />),
                ...cal.days.map((d) => {
                  const day = byDate.get(d.date)!;
                  const low = lowSet.has(d.date);
                  return (
                    <div key={d.date} onMouseEnter={() => setHoverDay(d.date)} onMouseLeave={() => setHoverDay(null)}
                      title={day.items.map((i) => `${i.name} ${fmt(i.amount)}`).join("\n")}
                      style={{ aspectRatio: "1", borderRadius: 8, padding: 3, background: hoverDay === d.date ? "var(--surface-2)" : low ? "color-mix(in srgb, var(--warn) 10%, transparent)" : "transparent", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2, cursor: day.items.length ? "pointer" : "default" }}>
                      <span className="num" style={{ fontSize: 10.5, color: "var(--ink-muted)" }}>{Number(d.date.slice(8))}</span>
                      {day.total > 0 && <span className="dot" style={{ width: 6, height: 6, background: low ? "var(--warn)" : "var(--accent)" }} />}
                    </div>
                  );
                }),
              ];
            })()}
          </div>
          {hoverDay && cal && (
            <div className="panel" style={{ marginTop: 10, padding: 10, fontSize: 12 }}>
              <b>{dayLabel(hoverDay)}</b>
              {(cal.days.find((d) => d.date === hoverDay)?.items ?? []).map((i) => (
                <div key={i.rpId} className="spread"><span>{i.name}</span><span className="num">{fmt(i.amount)}</span></div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <div className="spread" style={{ marginBottom: 4 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>Projected balance<Tip text="Expected balance across the month: start balance minus each bill on its due date, plus payday bumps. Amber shading marks days below your buffer floor (set in Settings)." /></div>
              <div className="muted" style={{ fontSize: 12 }}>expected bills vs. buffer floor {fmt(cal?.bufferFloor)}</div>
            </div>
            <div className="muted num" style={{ fontSize: 12 }}>start {fmt(cal?.startBalance)}</div>
          </div>
          <Chart option={ribbonOption} height={280} />
        </Card>
      </div>

      {(renewals.data?.renewals.length ?? 0) > 0 && (
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <span className="label" style={{ marginRight: 4 }}>Renewals ahead</span>
          {renewals.data!.renewals.map((r) => (
            <span key={r.rp_id} className="chip" style={{ background: "color-mix(in srgb, var(--warn) 12%, transparent)", color: "var(--warn)", fontSize: 11.5, padding: "4px 9px" }}>
              {r.name} · {fmt(r.expected_amount)} · {dayLabel(r.next_due_date)}
            </span>
          ))}
        </div>
      )}

      <Card style={{ padding: 8 }}>
        <div className="spread" style={{ padding: "12px 16px 10px" }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Registry<Tip text="Every tracked recurring payment. The sparkline is its price history — an amber creep badge means the amount has drifted up. 'Covered by: Work/Buildings' keeps a bill's payments out of the budget." /></div>
          <button className="btn" onClick={() => setDraft(newDraft())}>+ Add bill</button>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 100px 90px 110px 130px 70px", gap: 12, padding: "4px 16px 8px" }} className="tablehead">
          <div>Name</div><div style={{ textAlign: "right" }}>Amount</div><div>Freq</div><div>Next due</div><div>Price history</div><div />
        </div>
        {(active.data?.registry ?? []).map((r) => {
          const creep = priceCreep(r);
          const dleft = daysUntil(r.next_due_date);
          return (
            <div key={r.rp_id} className="hoverable" style={{ display: "grid", gridTemplateColumns: "1.4fr 100px 90px 110px 130px 70px", gap: 12, padding: "10px 16px", alignItems: "center" }}>
              <div>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{r.name}</span>
                <span
                  className={r.category_id ? "chip chip-accent" : "chip"}
                  style={{ marginLeft: 6, cursor: "pointer" }}
                  title="Edit category — also retargets the merchant mapping and re-categorizes past charges"
                  onClick={() => setCatEdit({ rpId: r.rp_id, name: r.name, categoryId: r.category_id })}>
                  {catLabel(r.category_id) ?? "set category"} ✎
                </span>
                {r.autopay === 1 && <span className="chip" style={{ marginLeft: 6 }}>autopay</span>}
                {r.reimbursed_by && <span className="chip chip-accent" style={{ marginLeft: 6 }}>{r.reimbursed_by === "work" ? "work pays" : "buildings pays"}</span>}
                {creep !== null && creep > 0 && <span className="chip" style={{ marginLeft: 6, background: "color-mix(in srgb, var(--warn) 12%, transparent)", color: "var(--warn)" }}>▲ {fmtC(creep)} creep</span>}
              </div>
              <div className="num" style={{ fontSize: 13, fontWeight: 600, textAlign: "right" }}>{fmtC(r.expected_amount)}</div>
              <div className="muted" style={{ fontSize: 12 }}>{r.frequency}</div>
              <div className="num" style={{ fontSize: 12.5, color: dleft <= 3 ? "var(--warn)" : "var(--ink)" }}>{dayLabel(r.next_due_date)} <span className="muted">({dleft}d)</span></div>
              <div>{r.priceHistory.length > 1 ? <Spark values={r.priceHistory.map((p) => p.amount)} height={24} color={creep && creep > 0 ? "var(--warn)" : "var(--accent)"} /> : <span className="muted" style={{ fontSize: 11 }}>—</span>}</div>
              <div className="row" style={{ gap: 4, justifyContent: "flex-end" }}>
                <span className="link" style={{ fontSize: 12 }} onClick={() => setDraft({ rpId: r.rp_id, name: r.name, expectedAmount: r.expected_amount, frequency: r.frequency, anchorDate: r.anchor_date, personId: r.person_id, categoryId: r.category_id, autopay: r.autopay === 1, reimbursedBy: r.reimbursed_by })}>edit</span>
                <span style={{ cursor: "pointer", color: "var(--ink-muted)", padding: "0 4px" }} onClick={() => remove.mutate(r.rp_id)}>×</span>
              </div>
            </div>
          );
        })}
        {active.data?.registry.length === 0 && <EmptyState text="No recurring payments tracked yet." action={<button className="btn" onClick={() => setDraft(newDraft())}>Add your first bill</button>} />}
      </Card>

      {draft && (
        <Modal title={draft.rpId ? "Edit bill" : "Add bill"} onClose={() => setDraft(null)}>
          <BillForm draft={draft} setDraft={setDraft} categories={categories.data?.categories ?? []}
            submitLabel={draft.rpId ? "Save changes" : "Add bill"}
            onSubmit={() => { save.mutate(draft); setDraft(null); }} />
        </Modal>
      )}

      {catEdit && (
        <Modal title={`Category for ${catEdit.name}`} onClose={() => setCatEdit(null)}>
          <div className="col" style={{ gap: 14 }}>
            <Field label="Category">
              <CategorySelect categories={categories.data?.categories ?? []} value={catEdit.categoryId}
                onChange={(categoryId) => setCatEdit({ ...catEdit, categoryId })} />
            </Field>
            <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
              This also retargets the merchant mapping for “{catEdit.name}” — even a locked 🔒 one — and
              re-categorizes the last 12 months of matched charges. Transactions you categorized by hand are never touched.
            </div>
            <button className="btn" disabled={!catEdit.categoryId || saveCategory.isPending}
              onClick={() => { saveCategory.mutate({ rpId: catEdit.rpId, categoryId: catEdit.categoryId! }); setCatEdit(null); }}>
              Save category
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
