import { useMemo, useState } from "react";
import { useAction, useApi, useCtx } from "../api/hooks";
import { api } from "../api/client";
import type { ShortTermDebtItem, ShortTermDebtView, ShortTermHistory } from "../api/types";
import { Card, EmptyState, Field, Modal } from "../components/ui";
import { Tip } from "../components/Tip";
import { Chart, chartBase, EChartsOption } from "../components/Chart";
import { cssVar, dayLabel, fmt, fmtC, monthLabel, monthShort } from "../lib/format";
import { useUi } from "../stores/ui";
import { DebtForm, toDraft, useDebtActions, type DebtDraft } from "./Debt";

interface StatementDraft {
  debtId: string;
  name: string;
  dueDate: string;
  statementBalance: string;
  minimumDue: string;
}

export function DebtShortTermPage() {
  const { lens, month, q } = useCtx();
  const theme = useUi((s) => s.theme);
  const [editing, setEditing] = useState<DebtDraft | null>(null);
  const [statement, setStatement] = useState<StatementDraft | null>(null);

  const view = useApi<ShortTermDebtView>(["debts.short", lens, month], `/api/debts/short-term${q}`);
  const history = useApi<ShortTermHistory>(["debts.short.history", lens, month], `/api/debts/short-term/history${q}&months=12`);
  const { save, payOff } = useDebtActions();

  const historyOption = useMemo<EChartsOption>(() => {
    const h = history.data;
    if (!h) return {};
    const base = chartBase(cssVar("--ink"), cssVar("--ink-muted"), cssVar("--line"));
    const series = [
      { name: "Spend on cards", color: cssVar("--warn"), data: h.months.map((m) => Math.round(m.spend)) },
      { name: "Payments made", color: cssVar("--accent"), data: h.months.map((m) => Math.round(m.payments)) },
      { name: "Interest charged", color: cssVar("--danger"), data: h.months.map((m) => Math.round(m.interest)) },
    ];
    return {
      ...base,
      legend: { textStyle: { color: cssVar("--ink-muted"), fontSize: 11 }, top: 0 },
      grid: { left: 8, right: 12, top: 32, bottom: 4, containLabel: true },
      xAxis: { type: "category", data: h.months.map((m) => monthShort(m.month) + (m.month.endsWith("-01") ? ` '${m.month.slice(2, 4)}` : "")), ...base.xAxis },
      yAxis: { type: "value", ...base.yAxis },
      series: series.map((s) => ({
        name: s.name, type: "bar" as const, data: s.data,
        itemStyle: { color: s.color, borderRadius: [3, 3, 0, 0] },
        barGap: "15%", barCategoryGap: "35%",
      })),
    };
  }, [history.data, theme]);
  const saveStatement = useAction(
    (s: StatementDraft) => api(`/api/debts/${s.debtId}/statement`, {
      method: "PUT",
      json: {
        month,
        dueDate: s.dueDate,
        statementBalance: s.statementBalance ? Number(s.statementBalance) : null,
        minimumDue: s.minimumDue ? Number(s.minimumDue) : null,
      },
    }),
    ["debts", "overview"],
  );

  const v = view.data;
  const openStatement = (d: ShortTermDebtItem) => setStatement({
    debtId: d.debt_id,
    name: d.name,
    dueDate: d.dueDate ?? "",
    statementBalance: d.statementSource === "statement" ? String(d.statementBalance) : "",
    minimumDue: d.minimumDue != null ? String(d.minimumDue) : "",
  });

  return (
    <div className="page col" style={{ gap: 20 }}>
      <div className="spread">
        <div>
          <div className="h1">Short-term debt · {monthLabel(month)}</div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>Revolving credit — cards, lines of credit. The goal: clear every statement and pay no interest.</div>
        </div>
        <button className="btn" onClick={() => setEditing({ name: "", kind: "credit_card", currentBalance: 0, apr: 19.99, minPayment: null, personId: null })}>+ Add debt</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16 }}>
        {[
          { label: "Revolving balance", v: fmt(v?.totalBalance), color: "var(--danger)" },
          { label: "Paid this month", v: fmt(v?.totalPaidThisMonth), color: "var(--accent)", tip: "Transfers that landed on these accounts this month — payments already made count against the statement." },
          { label: "Interest next month", v: fmt(v?.totalProjectedInterest), color: v && v.totalProjectedInterest > 0 ? "var(--warn)" : "var(--accent)", tip: "Projected interest on next month's statements. A fully-cleared statement charges nothing — even with new purchases on the card." },
          { label: "Pay-by dates", v: v ? (v.missingDueDates > 0 ? `${v.missingDueDates} missing` : "all set") : "—", color: v && v.missingDueDates > 0 ? "var(--warn)" : "var(--accent)", tip: "Credit cards need this month's pay-by date from the statement. Add the statement balance too for an exact interest projection." },
        ].map((k) => (
          <Card key={k.label} style={{ padding: "16px 18px" }}>
            <div className="label">{k.label}{"tip" in k && k.tip ? <Tip below text={k.tip as string} /> : null}</div>
            <div className="num" style={{ fontSize: 24, fontWeight: 600, marginTop: 5, color: k.color }}>{k.v}</div>
          </Card>
        ))}
      </div>

      {v && v.missingDueDates > 0 && (
        <Card style={{ borderLeft: "3px solid var(--warn)", padding: "14px 18px" }}>
          <span style={{ fontSize: 13 }}>⚠️ {v.missingDueDates} credit card{v.missingDueDates === 1 ? "" : "s"} still need{v.missingDueDates === 1 ? "s" : ""} a pay-by date for {monthLabel(month)} — set it from the statement below.</span>
        </Card>
      )}

      <Card style={{ padding: 8 }}>
        <div className="spread" style={{ padding: "12px 16px 10px" }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Cards & lines of credit<Tip text="Statement = what last month's statement asked to be paid (entered, or computed as the start-of-month balance). Paying it in full keeps the grace period: no interest next month, even on new purchases. Anything unpaid accrues at the card's APR." /></div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1.3fr 100px 100px 100px 110px 110px 120px 96px", gap: 12, padding: "4px 16px 8px" }} className="tablehead">
          <div>Name</div>
          <div style={{ textAlign: "right" }}>Balance</div>
          <div style={{ textAlign: "right" }}>Statement</div>
          <div style={{ textAlign: "right" }}>Paid</div>
          <div style={{ textAlign: "right" }}>Left to clear</div>
          <div style={{ textAlign: "right" }}>Interest next mo</div>
          <div>Pay by</div>
          <div />
        </div>
        {(v?.debts ?? []).map((d) => (
          <div key={d.debt_id} className="hoverable" style={{ display: "grid", gridTemplateColumns: "1.3fr 100px 100px 100px 110px 110px 120px 96px", gap: 12, padding: "10px 16px", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{d.name}</div>
              <div className="muted" style={{ fontSize: 11 }}>{d.kind.replace(/_/g, " ")} · {d.apr.toFixed(2)}%</div>
            </div>
            <div className="num" style={{ fontSize: 13, fontWeight: 600, textAlign: "right", color: "var(--danger)" }}>{fmtC(d.current_balance)}</div>
            <div className="num" style={{ fontSize: 12.5, textAlign: "right" }} title={d.statementSource === "statement" ? "from the statement you entered" : "computed start-of-month balance — enter the real statement balance for an exact number"}>
              {fmtC(d.statementBalance)}{d.statementSource === "computed" && <span className="muted">*</span>}
            </div>
            <div className="num" style={{ fontSize: 12.5, textAlign: "right", color: d.paidThisMonth > 0 ? "var(--accent)" : "var(--ink-muted)" }}>{fmtC(d.paidThisMonth)}</div>
            <div className="num" style={{ fontSize: 12.5, fontWeight: 600, textAlign: "right", color: d.statementCleared ? "var(--accent)" : "var(--ink)" }}>
              {d.statementCleared ? "cleared ✓" : fmtC(d.remainingStatement)}
            </div>
            <div className="num" style={{ fontSize: 12.5, fontWeight: 600, textAlign: "right", color: d.projectedInterest > 0 ? "var(--warn)" : "var(--accent)" }}>
              {d.projectedInterest > 0 ? fmtC(d.projectedInterest) : d.kind === "credit_card" ? "none 🎉" : fmtC(0)}
            </div>
            <div>
              {d.dueDate
                ? <span className="chip" style={{ cursor: "pointer" }} title="edit this month's statement" onClick={() => openStatement(d)}>{dayLabel(d.dueDate)}</span>
                : d.needsDueDate
                  ? <span className="chip" style={{ cursor: "pointer", background: "color-mix(in srgb, var(--warn) 14%, transparent)", color: "var(--warn)", fontWeight: 600 }} onClick={() => openStatement(d)}>set pay-by date</span>
                  : <span className="link muted" style={{ fontSize: 11.5 }} onClick={() => openStatement(d)}>add</span>}
            </div>
            <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
              <span className="link" style={{ fontSize: 12 }} onClick={() => setEditing(toDraft(d))}>edit</span>
              <span className="link" style={{ fontSize: 12, color: "var(--gold)" }} onClick={() => payOff.mutate(d.debt_id)}>paid off</span>
            </div>
          </div>
        ))}
        {v?.debts.length === 0 && <EmptyState text="No revolving debt — nothing carries interest month to month. 🎉" />}
        {v && v.debts.some((d) => d.statementSource === "computed") && (
          <div className="muted" style={{ padding: "8px 16px 10px", fontSize: 11 }}>* computed from the start-of-month balance — open the pay-by dialog to enter the real statement balance.</div>
        )}
      </Card>

      <Card style={{ padding: "22px 24px" }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>
          Monthly picture — spend vs payments vs interest
          <Tip text="Per month, for all cards and lines of credit together: new purchases charged (amber), payments that landed on the accounts (green), and interest actually charged by the bank (red). A healthy month has payments ≥ spend and no red." />
        </div>
        <div className="muted" style={{ fontSize: 12, marginBottom: 8 }}>last 12 months · only debts linked to a synced account contribute</div>
        <Chart option={historyOption} height={260} />
      </Card>

      {editing && (
        <Modal title={editing.debtId ? "Edit debt" : "Add debt"} onClose={() => setEditing(null)}>
          <DebtForm initial={editing} submitLabel={editing.debtId ? "Save" : "Add debt"} onSubmit={(d) => { save.mutate(d); setEditing(null); }} />
        </Modal>
      )}

      {statement && (
        <Modal title={`${statement.name} — ${monthLabel(month)} statement`} onClose={() => setStatement(null)}>
          <div className="col" style={{ gap: 13 }}>
            <Field label="Pay-by date" hint="the statement's payment due date — required for credit cards every month">
              <input className="input" type="date" value={statement.dueDate} onChange={(e) => setStatement({ ...statement, dueDate: e.target.value })} />
            </Field>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="Statement balance" hint="optional — exact carry from the statement">
                <input className="input num" type="number" min={0} value={statement.statementBalance} onChange={(e) => setStatement({ ...statement, statementBalance: e.target.value })} />
              </Field>
              <Field label="Minimum due" hint="optional">
                <input className="input num" type="number" min={0} value={statement.minimumDue} onChange={(e) => setStatement({ ...statement, minimumDue: e.target.value })} />
              </Field>
            </div>
            <button className="btn" disabled={!statement.dueDate} onClick={() => { saveStatement.mutate(statement); setStatement(null); }}>Save statement</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
