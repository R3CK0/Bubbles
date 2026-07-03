import { useEffect, useMemo, useRef, useState } from "react";
import { useAction, useApi, useCtx, usePersons } from "../api/hooks";
import { api } from "../api/client";
import type { BracketFill, BudgetView, CoupleStrategy, OptimizerResult, RoomView, TaxEstimate, TaxProfile } from "../api/types";
import { Card, Field, Modal } from "../components/ui";
import { Tip } from "../components/Tip";
import { Chart, EChartsOption } from "../components/Chart";
import { cssVar, fmt, fmtC, fmtPct } from "../lib/format";
import { ExtraIncome, extraGrossAnnual, parseExtra } from "../lib/tax";
import { useUi } from "../stores/ui";

const YEAR = new Date().getFullYear();

function gaugeOption(marginal: number, average: number): EChartsOption {
  return {
    series: [{
      type: "gauge", startAngle: 200, endAngle: -20, min: 0, max: 60, radius: "100%", center: ["50%", "62%"],
      progress: { show: true, width: 10, itemStyle: { color: cssVar("--accent") } },
      axisLine: { lineStyle: { width: 10, color: [[1, cssVar("--surface-2")]] } },
      axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
      pointer: { length: "58%", width: 4, itemStyle: { color: cssVar("--ink") } },
      anchor: { show: true, size: 8, itemStyle: { color: cssVar("--ink") } },
      title: { show: false },
      detail: { valueAnimation: true, formatter: (v: number) => `${v.toFixed(1)}%`, color: cssVar("--ink"), fontSize: 18, fontWeight: 600, offsetCenter: [0, "40%"] },
      data: [{ value: marginal * 100 }],
    }],
    graphic: [{ type: "text", left: "center", top: "88%", style: { text: `avg ${(average * 100).toFixed(1)}%`, fill: cssVar("--ink-muted"), fontSize: 11 } }],
  };
}

function BracketGlass({ glass }: { glass: BracketFill }) {
  const tiers = [...glass.tiers].reverse(); // top bracket on top
  return (
    <div className="col" style={{ gap: 3, flex: 1 }}>
      <div className="muted" style={{ fontSize: 10.5, fontWeight: 700, textAlign: "center" }}>{glass.jurisdiction === "CA" ? "Federal" : "Québec"}</div>
      {tiers.map((t, i) => {
        const pct = t.capacity === null ? (t.filled > 0 ? 1 : 0) : Math.min(1, t.filled / Math.max(1, t.capacity));
        return (
          <div key={i} title={`${(t.rate * 100).toFixed(1)}% bracket · ${fmt(t.filled)} in`} style={{ position: "relative", height: 20, borderRadius: 5, background: "var(--surface-2)", overflow: "hidden" }}>
            <div style={{ position: "absolute", inset: 0, width: `${pct * 100}%`, background: pct >= 1 ? "var(--accent)" : "color-mix(in srgb, var(--accent) 55%, transparent)", transition: "width .8s cubic-bezier(.3,0,.2,1)" }} />
            <div className="num" style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 7px", fontSize: 9.5, fontWeight: 600 }}>
              <span>{(t.rate * 100).toFixed(1)}%</span>
              {t.filled > 0 && <span>{fmt(t.filled)}</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function Taxes() {
  const { lens, month, q } = useCtx();
  const theme = useUi((s) => s.theme);
  const persons = usePersons();
  const [year, setYear] = useState(YEAR);
  const yq = `${q}&year=${year}`;

  const estimate = useApi<TaxEstimate>(["tax.estimate", lens, year], `/api/tax/estimate${yq}`);
  const room = useApi<{ room: RoomView[] }>(["tax.room", lens, year], `/api/tax/room${yq}`);
  const strategies = useApi<{ strategies: CoupleStrategy[] }>(["tax.strategies", lens, year], `/api/tax/strategies${yq}`);
  const profiles = useApi<{ profiles: TaxProfile[] }>(["tax.profiles", year], `/api/tax/profile?year=${year}`);
  const budget = useApi<BudgetView>(["budget.view", lens, month], `/api/budget${q}`);

  const [profileOpen, setProfileOpen] = useState<string | null>(null);
  const [roomOpen, setRoomOpen] = useState(false);
  const [openStrategy, setOpenStrategy] = useState<string | null>(null);

  // ---- automated proposal: deployable cash derived from the budget surplus ----
  const monthsRemaining = 12 - Number(month.slice(5, 7)) + 1;
  const budgetSurplus = useMemo(() => {
    const rows = budget.data?.rows ?? [];
    const income = rows.filter((r) => r.kind === "income").reduce((t, r) => t + r.budget, 0);
    const spend = rows.filter((r) => r.kind === "expense" && r.parentId === null).reduce((t, r) => t + r.budget, 0);
    return Math.max(0, Math.round(income - spend));
  }, [budget.data]);
  const suggestedDeploy = budgetSurplus * monthsRemaining;

  const [deploy, setDeploy] = useState<number | null>(null); // null until budget loads
  const [proposal, setProposal] = useState<OptimizerResult | null>(null);
  const inflight = useRef(false);
  const pendingAmt = useRef<number | null>(null);

  const runOptimizer = (amount: number) => {
    if (inflight.current) { pendingAmt.current = amount; return; }
    inflight.current = true;
    api<OptimizerResult>(`/api/tax/optimize${q}`, { method: "POST", json: { deployableCash: amount, year } })
      .then(setProposal)
      .catch(() => setProposal(null))
      .finally(() => {
        inflight.current = false;
        if (pendingAmt.current !== null) { const a = pendingAmt.current; pendingAmt.current = null; runOptimizer(a); }
      });
  };

  useEffect(() => {
    if (deploy === null && budget.data) {
      setDeploy(suggestedDeploy);
      if (suggestedDeploy > 0) runOptimizer(suggestedDeploy);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [budget.data]);

  const accept = useAction(
    () => api(`/api/tax/optimize/accept${q}`, { method: "POST", json: { deployableCash: deploy ?? 0, year, planName: `Tax plan ${year}` } }),
    ["tax", "goals", "plans", "overview"],
  );
  const saveProfile = useAction(
    (p: { personId: string; employmentIncome: number; withholdingPaid: number; weeklyTakeHome: number | null; otherIncome: ExtraIncome }) =>
      api("/api/tax/profile", {
        method: "PUT",
        json: {
          personId: p.personId, taxYear: year, employmentIncome: p.employmentIncome,
          withholdingPaid: p.withholdingPaid, weeklyTakeHome: p.weeklyTakeHome,
          otherIncome: p.otherIncome,
        },
      }),
    ["tax"],
  );
  const saveRoom = useAction(
    (rooms: { personId: string; accountType: "FHSA" | "TFSA" | "RRSP"; roomAmount: number }[]) =>
      api("/api/tax/room", { method: "PUT", json: { rooms: rooms.map((r) => ({ ...r, taxYear: year })) } }),
    ["tax"],
  );

  const e = estimate.data;
  const personName = (id: string) => persons.data?.persons.find((p) => p.person_id === id)?.display_name ?? id;
  const hasProfiles = (profiles.data?.profiles.length ?? 0) > 0;
  const maxDeploy = Math.max(suggestedDeploy * 2, 50_000);
  const balance = e?.household.balance ?? 0;
  const beamTilt = Math.max(-14, Math.min(14, (balance / 5000) * 14));

  return (
    <div className="page col" style={{ gap: 20 }}>
      <div className="spread">
        <div>
          <div className="h1">Taxes · {year}</div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>Québec + federal estimate, contribution-room optimizer, couple strategies</div>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <select className="input" style={{ width: 110 }} value={year} onChange={(ev) => setYear(Number(ev.target.value))}>
            {[YEAR, YEAR + 1].map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
          <button className="btn-ghost" onClick={() => setRoomOpen(true)}>Contribution room</button>
        </div>
      </div>

      {!hasProfiles && (
        <Card style={{ borderLeft: "3px solid var(--warn)", padding: "14px 18px" }} className="row">
          <span style={{ fontSize: 13 }}>⚠️ No income assumptions saved for {year} — the estimate runs on defaults. Set each person's income below.</span>
        </Card>
      )}

      {/* household summary + balance beam */}
      {e && (
        <Card className="spread" style={{ flexWrap: "wrap", gap: 18 }}>
          {[
            { label: "Household income", v: fmt(e.household.totalIncome) },
            { label: "Income tax", v: fmt(e.household.totalIncomeTax) },
            { label: "Payroll (QPP/QPIP/EI)", v: fmt(e.household.totalPayroll) },
            { label: "Average rate", v: fmtPct(e.household.averageRate, 1) },
          ].map((k) => (
            <div key={k.label}>
              <div className="label">{k.label}</div>
              <div className="num" style={{ fontSize: 22, fontWeight: 600, marginTop: 4 }}>{k.v}</div>
            </div>
          ))}
          <div style={{ textAlign: "center", minWidth: 190 }}>
            <div className="label" style={{ marginBottom: 8 }}>{balance > 0 ? "Owing" : "Refund"}<Tip text="Estimated total tax minus what's been withheld from pay so far. Tilted red = expect to owe at filing; green = a refund is coming. Keep 'tax withheld to date' current for an honest beam." /></div>
            <div style={{ position: "relative", height: 44 }}>
              <div style={{ position: "absolute", left: "50%", bottom: 0, width: 2, height: 16, background: "var(--ink-muted)", transform: "translateX(-50%)" }} />
              <div style={{ position: "absolute", left: "50%", bottom: 14, width: 150, height: 3, borderRadius: 2, background: "var(--ink-muted)", transform: `translateX(-50%) rotate(${beamTilt}deg)`, transformOrigin: "center", transition: "transform .6s cubic-bezier(.3,0,.2,1)" }} />
              <div className="num" style={{ position: "absolute", inset: 0, display: "flex", alignItems: "flex-start", justifyContent: "center", fontSize: 19, fontWeight: 700, color: balance > 0 ? "var(--danger)" : "var(--accent)" }}>
                {fmt(Math.abs(balance))}
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* per-person columns */}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.max(1, e?.perPerson.length ?? 2)},1fr)`, gap: 20 }}>
        {(e?.perPerson ?? []).map((p) => {
          const profile = profiles.data?.profiles.find((x) => x.person_id === p.personId);
          return (
            <Card key={p.personId}>
              <div className="spread">
                <div style={{ fontSize: 15, fontWeight: 600 }}>{personName(p.personId)}</div>
                <span className="link" style={{ fontSize: 12 }} onClick={() => setProfileOpen(p.personId)}>
                  {profile ? "edit income" : "set income"}
                </span>
              </div>
              <div className="row" style={{ gap: 16, marginTop: 8 }}>
                <div style={{ width: 150, height: 120 }}>
                  <Chart option={gaugeOption(p.marginalRate, p.averageRate)} height={120} />
                </div>
                <div className="col" style={{ gap: 5, fontSize: 12.5, flex: 1 }}>
                  <div className="spread"><span className="muted">Income</span><b className="num">{fmt(p.totalIncome)}</b></div>
                  <div className="spread"><span className="muted">Federal</span><b className="num">{fmt(p.federal.netTax)}</b></div>
                  <div className="spread"><span className="muted">Québec</span><b className="num">{fmt(p.quebec.netTax)}</b></div>
                  <div className="spread"><span className="muted">Payroll</span><b className="num">{fmt(p.payroll.total)}</b></div>
                  <div className="spread" style={{ paddingTop: 5, borderTop: "1px solid var(--line)" }}>
                    <span className="muted">{p.balance > 0 ? "Owing" : "Refund"}</span>
                    <b className="num" style={{ color: p.balance > 0 ? "var(--danger)" : "var(--accent)" }}>{fmt(Math.abs(p.balance))}</b>
                  </div>
                </div>
              </div>
              <div className="row" style={{ gap: 10, marginTop: 14, alignItems: "flex-start" }}>
                {p.glasses.map((g) => <BracketGlass key={g.jurisdiction} glass={g} />)}
              </div>
              {/* room summary */}
              <div className="row" style={{ gap: 6, marginTop: 14, flexWrap: "wrap" }}>
                {(room.data?.room ?? []).filter((r) => r.personId === p.personId).map((r) => (
                  <span key={r.accountType} className="chip" title={`contributed ${fmt(r.contributed)} of ${fmt(r.room)}`}>
                    {r.accountType} <b className="num" style={{ color: "var(--accent)" }}>{fmt(r.remaining)}</b> left
                  </span>
                ))}
                {profile?.weekly_take_home != null && profile.weekly_take_home > 0 && (() => {
                  const estNetM = (p.totalIncome - p.totalIncomeTax - p.payroll.total) / 12;
                  const extra = estNetM - (profile.weekly_take_home * 52) / 12;
                  return extra > 15 ? (
                    <span className="chip" style={{ background: "color-mix(in srgb, var(--warn) 12%, transparent)", color: "var(--warn)" }}
                      title="gap between the bracket estimate's after-tax pay and your actual weekly deposits — group insurance, pension, union dues…">
                      other paycheque deductions ≈ {fmt(extra)}/mo
                    </span>
                  ) : null;
                })()}
              </div>
            </Card>
          );
        })}
      </div>

      {/* ---- automated proposal / optimizer ---- */}
      <Card style={{ borderLeft: "3px solid var(--accent)" }}>
        <div className="spread" style={{ flexWrap: "wrap", gap: 14 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Proposed plan — lowest tax first<Tip text="Deployable cash defaults to your budget surplus × months left in the year. The optimizer fills FHSA first (deduct now, withdraw tax-free for a home), then RRSP against the highest marginal rate, then TFSA — never exceeding contribution room. Accepting turns it into monthly plan lines." /></div>
            <div className="muted" style={{ fontSize: 12.5, marginTop: 3, maxWidth: 560, lineHeight: 1.5 }}>
              Your budget frees up <b className="num" style={{ color: "var(--accent)" }}>{fmt(budgetSurplus)}/mo</b>; over the {monthsRemaining} months left in {year} that's <b className="num">{fmt(suggestedDeploy)}</b> deployable.
              The optimizer fills FHSA first (deduct now, withdraw tax-free), then RRSP against the highest marginal rate, then TFSA.
            </div>
          </div>
          {proposal && (
            <div style={{ textAlign: "right" }}>
              <div className="label">Tax saved</div>
              <div className="num" style={{ fontSize: 30, fontWeight: 700, color: "var(--accent)" }}>{fmt(proposal.totalTaxSaved)}</div>
            </div>
          )}
        </div>

        <div className="col" style={{ gap: 4, marginTop: 16, maxWidth: 640 }}>
          <div className="spread muted" style={{ fontSize: 12 }}>
            <span>Cash to deploy this year</span>
            <b className="num" style={{ color: "var(--ink)" }}>{fmt(deploy ?? 0)}</b>
          </div>
          <input type="range" min={0} max={maxDeploy} step={250} value={deploy ?? 0}
            onChange={(ev) => { const v = Number(ev.target.value); setDeploy(v); runOptimizer(v); }}
            style={{ accentColor: "var(--accent)" }} />
          <div className="row" style={{ gap: 8 }}>
            <span className="link" style={{ fontSize: 11.5 }} onClick={() => { setDeploy(suggestedDeploy); runOptimizer(suggestedDeploy); }}>reset to budget surplus</span>
          </div>
        </div>

        {proposal && proposal.allocations.length > 0 && (
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${proposal.allocations.length},1fr)`, gap: 16, marginTop: 16 }}>
            {proposal.allocations.map((a) => {
              const total = a.fhsa + a.rrsp + a.tfsa || 1;
              const segs = [
                { key: "FHSA", v: a.fhsa, color: "var(--accent)" },
                { key: "RRSP", v: a.rrsp, color: "var(--gold)" },
                { key: "TFSA", v: a.tfsa, color: "#5EA8D9" },
              ].filter((s) => s.v > 0);
              return (
                <div key={a.personId} className="panel" style={{ padding: 14 }}>
                  <div className="spread" style={{ marginBottom: 8 }}>
                    <b style={{ fontSize: 13 }}>{personName(a.personId)}</b>
                    <span className="num muted" style={{ fontSize: 12 }}>saves {fmt(a.taxSaved)}</span>
                  </div>
                  <div style={{ display: "flex", height: 14, borderRadius: 7, overflow: "hidden", background: "var(--surface)" }}>
                    {segs.map((s) => <div key={s.key} title={`${s.key} ${fmt(s.v)}`} style={{ width: `${(s.v / total) * 100}%`, background: s.color, transition: "width .5s cubic-bezier(.3,0,.2,1)" }} />)}
                  </div>
                  <div className="col" style={{ gap: 4, marginTop: 8, fontSize: 12 }}>
                    {segs.map((s) => (
                      <div key={s.key} className="spread">
                        <span className="row" style={{ gap: 6 }}><span className="dot" style={{ width: 8, height: 8, background: s.color }} />{s.key}</span>
                        <b className="num">{fmt(s.v)}</b>
                      </div>
                    ))}
                    {a.reasons.map((r, i) => <div key={i} className="muted" style={{ fontSize: 11, lineHeight: 1.4 }}>· {r}</div>)}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {proposal && proposal.monthlySchedule.length > 0 && (
          <div className="row" style={{ gap: 8, marginTop: 14, flexWrap: "wrap" }}>
            <span className="label">Monthly:</span>
            {proposal.monthlySchedule.map((s, i) => (
              <span key={i} className="chip chip-accent">{personName(s.personId)} · {s.type.toUpperCase()} {fmtC(s.monthly)}/mo</span>
            ))}
          </div>
        )}

        <div className="row" style={{ gap: 10, marginTop: 16 }}>
          <button className="btn" disabled={!proposal || (deploy ?? 0) <= 0 || accept.isPending} onClick={() => accept.mutate()}>
            {accept.isSuccess ? "✓ Plan accepted" : "Accept plan → contributions become plan lines"}
          </button>
          {accept.isSuccess && <span className="muted" style={{ fontSize: 12 }}>the Goals page now reflects this plan</span>}
        </div>
      </Card>

      {/* couple strategies */}
      <Card style={{ padding: 8 }}>
        <div style={{ padding: "12px 16px 8px", fontSize: 14, fontWeight: 600 }}>More ways to lower the bill<Tip text="Couple-coordination strategies priced by the deterministic engine: spousal RRSP to even out retirement incomes, pooling donation/medical credits on one return, and timing deductions across years." /></div>
        {(strategies.data?.strategies ?? []).map((s) => (
          <div key={s.kind} className="hoverable" style={{ padding: "12px 16px", cursor: "pointer" }} onClick={() => setOpenStrategy(openStrategy === s.kind ? null : s.kind)}>
            <div className="spread">
              <div style={{ fontSize: 13.5, fontWeight: 600 }}>{s.title}</div>
              <div className="num" style={{ fontSize: 13, fontWeight: 700, color: s.dollarImpact > 0 ? "var(--accent)" : "var(--ink-muted)" }}>
                {s.dollarImpact > 0 ? `≈ ${fmt(s.dollarImpact)}` : "—"}
              </div>
            </div>
            {openStrategy === s.kind && (
              <div style={{ marginTop: 8, animation: "bb-rowin .2s ease-out" }}>
                <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.5 }}>{s.description}</div>
                <div className="col" style={{ gap: 4, marginTop: 8 }}>
                  {s.actions.map((a, i) => <div key={i} style={{ fontSize: 12.5 }}>→ {a}</div>)}
                  {s.caveats.map((c, i) => <div key={i} className="muted" style={{ fontSize: 11.5 }}>⚠ {c}</div>)}
                </div>
              </div>
            )}
          </div>
        ))}
        {strategies.data?.strategies.length === 0 && <div className="empty">Strategies appear once both incomes are set for {year}.</div>}
        {(e?.scopeExclusions.length ?? 0) > 0 && (
          <div className="muted" style={{ padding: "10px 16px", fontSize: 11.5, lineHeight: 1.5 }}>Not modeled: {e!.scopeExclusions.join(" · ")}</div>
        )}
      </Card>

      {profileOpen && (
        <ProfileModal personId={profileOpen} name={personName(profileOpen)} year={year}
          existing={profiles.data?.profiles.find((x) => x.person_id === profileOpen) ?? null}
          onClose={() => setProfileOpen(null)}
          onSave={(inc, wh, weekly, other) => { saveProfile.mutate({ personId: profileOpen, employmentIncome: inc, withholdingPaid: wh, weeklyTakeHome: weekly, otherIncome: other }); setProfileOpen(null); }} />
      )}

      {roomOpen && (
        <RoomModal rooms={room.data?.room ?? []} personName={personName} onClose={() => setRoomOpen(false)}
          onSave={(rows) => { saveRoom.mutate(rows); setRoomOpen(false); }} />
      )}
    </div>
  );
}

function ProfileModal({ personId, name, year, existing, onClose, onSave }: {
  personId: string; name: string; year: number; existing: TaxProfile | null;
  onClose: () => void; onSave: (income: number, withholding: number, weekly: number | null, other: ExtraIncome) => void;
}) {
  const [income, setIncome] = useState(existing?.employment_income ?? 0);
  const [withholding, setWithholding] = useState(existing?.withholding_paid ?? 0);
  const [weekly, setWeekly] = useState(existing?.weekly_take_home ?? 0);
  const [other, setOther] = useState<ExtraIncome>(parseExtra(existing?.other_income_json));
  const setX = (k: keyof ExtraIncome, v: string) => setOther((s) => ({ ...s, [k]: Number(v) > 0 ? Number(v) : undefined }));
  void personId;
  return (
    <Modal title={`${name} — ${year} income`} onClose={onClose}>
      <div className="col" style={{ gap: 13 }}>
        <Field label="Employment income (annual gross)"><input className="input num" type="number" min={0} value={income || ""} onChange={(e) => setIncome(Number(e.target.value))} /></Field>
        <Field label="Weekly take-home (net deposit)" hint="what actually lands in the bank — the gap vs the bracket estimate exposes group insurance / pension deductions">
          <input className="input num" type="number" min={0} value={weekly || ""} onChange={(e) => setWeekly(Number(e.target.value))} />
        </Field>
        <Field label="Tax withheld to date" hint="from pay stubs — drives the owing/refund beam"><input className="input num" type="number" min={0} value={withholding || ""} onChange={(e) => setWithholding(Number(e.target.value))} /></Field>
        <div className="label">Extra income / yr</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Field label="Rental (net)" hint="until Buildings tracking supplies it"><input className="input num" type="number" min={0} value={other.rentalNet ?? ""} onChange={(e) => setX("rentalNet", e.target.value)} /></Field>
          <Field label="Interest"><input className="input num" type="number" min={0} value={other.interest ?? ""} onChange={(e) => setX("interest", e.target.value)} /></Field>
          <Field label="Eligible dividends"><input className="input num" type="number" min={0} value={other.eligibleDividends ?? ""} onChange={(e) => setX("eligibleDividends", e.target.value)} /></Field>
          <Field label="Capital gains"><input className="input num" type="number" min={0} value={other.capitalGains ?? ""} onChange={(e) => setX("capitalGains", e.target.value)} /></Field>
        </div>
        <button className="btn" onClick={() => onSave(income, withholding, weekly > 0 ? weekly : null, other)}>Save assumptions</button>
      </div>
    </Modal>
  );
}

function RoomModal({ rooms, personName, onClose, onSave }: {
  rooms: RoomView[]; personName: (id: string) => string; onClose: () => void;
  onSave: (rows: { personId: string; accountType: "FHSA" | "TFSA" | "RRSP"; roomAmount: number }[]) => void;
}) {
  const [edits, setEdits] = useState<Record<string, number>>(Object.fromEntries(rooms.map((r) => [`${r.personId}|${r.accountType}`, r.room])));
  return (
    <Modal title="Contribution room (from CRA / My Account)" onClose={onClose} width={480}>
      <div className="col" style={{ gap: 10 }}>
        {rooms.map((r) => {
          const key = `${r.personId}|${r.accountType}`;
          return (
            <div key={key} className="row" style={{ gap: 12 }}>
              <span style={{ flex: 1, fontSize: 13 }}>{personName(r.personId)} · <b>{r.accountType}</b></span>
              <input className="input num" type="number" min={0} style={{ width: 130 }} value={edits[key] ?? 0} onChange={(e) => setEdits({ ...edits, [key]: Number(e.target.value) })} />
            </div>
          );
        })}
        {rooms.length === 0 && <div className="empty">Room rows appear after the first nightly run — or save incomes first.</div>}
        <button className="btn" disabled={rooms.length === 0}
          onClick={() => onSave(Object.entries(edits).map(([k, v]) => { const [personId, accountType] = k.split("|"); return { personId, accountType: accountType as "FHSA" | "TFSA" | "RRSP", roomAmount: v }; }))}>
          Save room
        </button>
      </div>
    </Modal>
  );
}
