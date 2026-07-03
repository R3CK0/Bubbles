import { useNavigate } from "react-router-dom";
import { useAction, useOverview } from "../api/hooks";
import { api } from "../api/client";
import { Card, Ring, Spark, Feasibility, EmptyState } from "../components/ui";
import { Tip } from "../components/Tip";
import { fmt, fmtDelta, dayLabel } from "../lib/format";

export function Overview() {
  const nav = useNavigate();
  const { data, isLoading } = useOverview();
  const ack = useAction((id: string) => api(`/api/alerts/${id}/ack`, { method: "POST", json: {} }), ["alerts", "overview"]);

  if (isLoading || !data) return <div className="page muted">Loading…</div>;

  const { hero, cashflow, goals, next7Days, lowWindows, alerts } = data;
  const delta = hero.monthDelta;
  const onTrack = goals.filter((g) => g.feasible === "yes").length;
  const lowDates = new Set(lowWindows.flatMap((w) => {
    const days: string[] = [];
    for (let d = new Date(w.start + "T00:00:00"); d <= new Date(w.end + "T00:00:00"); d.setDate(d.getDate() + 1)) days.push(d.toISOString().slice(0, 10));
    return days;
  }));

  const kpis = [
    { label: "Money in", value: cashflow.income, color: "var(--accent)", to: "/cashflow", tip: "This month's income through the person lens. Transfers, work reimbursements, and goal-tagged rows are excluded." },
    { label: "Money out", value: cashflow.spend, color: "var(--ink)", to: "/cashflow", tip: "This month's household spending — after exclusions, so reimbursed or goal expenses don't bust it." },
    { label: "Net this month", value: cashflow.net, color: cashflow.net >= 0 ? "var(--accent)" : "var(--danger)", to: "/budget", tip: "Money in minus money out. Positive = the month is funding buffers, debts, and goals." },
    { label: "Goals on track", value: null as number | null, custom: `${onTrack}/${goals.length}`, color: onTrack === goals.length ? "var(--accent)" : "var(--warn)", to: "/goals", tip: "The affordability solver's verdicts: goals it can fully fund by their target dates at current free cash flow." },
  ];

  return (
    <div className="page" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 300px", gap: 20 }}>
      <div className="col" style={{ gap: 20, minWidth: 0 }}>
        <Card style={{ padding: "26px 28px", display: "grid", gridTemplateColumns: "minmax(0,1fr) minmax(0,1.1fr)", gap: 20, alignItems: "center" }}>
          <div>
            <div className="label">Combined net worth<Tip text="Tracked account balances plus manual assets, minus debts — snapshotted daily by the nightly job. The sparkline is the last 90 days; a gold flag marks a record high." /></div>
            <div className="num" style={{ fontSize: 52, fontWeight: 600, letterSpacing: "-.02em", lineHeight: 1.05, marginTop: 6 }}>{fmt(hero.current)}</div>
            {delta !== null && (
              <div className="num" style={{ display: "inline-flex", alignItems: "center", gap: 6, marginTop: 12, padding: "5px 11px", borderRadius: 20, fontSize: 13, fontWeight: 600, background: delta >= 0 ? "var(--accent-soft)" : "color-mix(in srgb, var(--danger) 10%, transparent)", color: delta >= 0 ? "var(--accent)" : "var(--danger)" }}>
                {fmtDelta(delta)} <span style={{ opacity: 0.7 }}>this month</span>
              </div>
            )}
            {hero.lastMilestone && (
              <div style={{ marginTop: 10, fontSize: 11.5, color: "var(--gold)", fontWeight: 600 }}>⚑ record {fmt(hero.lastMilestone.value)} on {dayLabel(hero.lastMilestone.date)}</div>
            )}
          </div>
          <div style={{ minWidth: 0, cursor: "pointer" }} onClick={() => nav("/networth")}>
            <Spark values={hero.spark90d.map((p) => p.value)} height={120} />
          </div>
        </Card>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16 }}>
          {kpis.map((k) => (
            <Card key={k.label} style={{ padding: "16px 18px", cursor: "pointer" }} onClick={() => nav(k.to)}>
              <div className="label" style={{ textTransform: "none", letterSpacing: 0, fontSize: 12.5 }}>{k.label}{"tip" in k && k.tip ? <Tip below text={k.tip} /> : null}</div>
              <div className="num" style={{ fontSize: 26, fontWeight: 600, marginTop: 6, color: k.color }}>
                {"custom" in k && k.custom ? k.custom : fmt(k.value)}
              </div>
            </Card>
          ))}
        </div>

        <Card>
          <div className="spread" style={{ marginBottom: 14 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Goals</div>
            <span className="link" style={{ fontSize: 12 }} onClick={() => nav("/goals")}>Plan →</span>
          </div>
          {goals.length === 0 ? (
            <EmptyState text="No goals yet." action={<button className="btn" onClick={() => nav("/goals")}>Set your first goal</button>} />
          ) : (
            <div style={{ display: "flex", gap: 14, overflowX: "auto", paddingBottom: 4 }}>
              {goals.map((g) => {
                const color = g.feasible === "yes" ? "var(--accent)" : g.feasible === "tight" ? "var(--warn)" : "var(--danger)";
                return (
                  <div key={g.goalId} className="panel col" style={{ flex: "none", width: 142, padding: 16, alignItems: "center", gap: 10, cursor: "pointer" }} onClick={() => nav("/goals")}>
                    <Ring pct={g.progress} color={color} />
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.2 }}>{g.name}</div>
                      <div style={{ marginTop: 5 }}><Feasibility verdict={g.feasible} /></div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      <div className="col" style={{ gap: 16, minWidth: 0 }}>
        <Card style={{ padding: "18px 20px" }}>
          <div className="spread" style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Next 7 days<Tip text="Upcoming bills from the recurring registry. An amber pulsing dot means the projected balance dips below your buffer floor that day." /></div>
            <span className="link" style={{ fontSize: 12 }} onClick={() => nav("/bills")}>Bills →</span>
          </div>
          {next7Days.every((d) => d.items.length === 0) && <div className="empty">Nothing due this week</div>}
          {next7Days.flatMap((d) =>
            d.items.map((b) => (
              <div key={b.rpId + d.date} className="row" style={{ gap: 11, padding: "9px 0" }}>
                <span className="dot" style={{ width: 9, height: 9, background: lowDates.has(d.date) ? "var(--warn)" : "var(--surface-2)", border: "1px solid var(--line)", animation: lowDates.has(d.date) ? "bb-pulse 2s ease-in-out infinite" : undefined }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{b.name}</div>
                  <div className="muted" style={{ fontSize: 11 }}>{dayLabel(d.date)}</div>
                </div>
                <div className="num" style={{ fontSize: 13, fontWeight: 600 }}>{fmt(b.amount)}</div>
              </div>
            )),
          )}
        </Card>

        {alerts.map((a, i) => {
          const color = a.severity === "critical" ? "var(--danger)" : a.severity === "warning" ? "var(--warn)" : "var(--accent)";
          return (
            <div key={a.alert_id} className="card" style={{ borderLeft: `3px solid ${color}`, padding: "14px 16px", animation: "bb-slidein .5s cubic-bezier(.3,0,.2,1) both", animationDelay: `${i * 90}ms` }}>
              <div className="spread" style={{ alignItems: "flex-start", gap: 8 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color }}>{a.title}</div>
                <div style={{ cursor: "pointer", color: "var(--ink-muted)", fontSize: 15, lineHeight: 1 }} onClick={() => ack.mutate(a.alert_id)}>×</div>
              </div>
              {a.body && <div className="muted" style={{ fontSize: 12, marginTop: 5, lineHeight: 1.45 }}>{a.body}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
