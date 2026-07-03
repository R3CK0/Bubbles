import { useMemo, useState } from "react";
import { useApi, useCtx } from "../api/hooks";
import type { LongTermDebtView, PayoffPlan, StrategyComparison } from "../api/types";
import { Card, EmptyState, Modal, Seg } from "../components/ui";
import { Tip } from "../components/Tip";
import { Chart, chartBase, EChartsOption } from "../components/Chart";
import { cssVar, fmt, fmtC, monthLabel, monthShort, palette } from "../lib/format";
import { useUi } from "../stores/ui";
import { DebtForm, toDraft, useDebtActions, type DebtDraft } from "./Debt";

const timeLeft = (months: number) => {
  const y = Math.floor(months / 12);
  const m = months % 12;
  return y > 0 ? `${y}y${m > 0 ? ` ${m}m` : ""}` : `${m}m`;
};

const SOURCE_LABEL = { bill: "from bills", min_payment: "min payment", fallback: "2% fallback" } as const;
const SOURCE_TIP = {
  bill: "The recurring payment linked to this debt on the Bills page — the amount your budget sets aside.",
  min_payment: "No linked bill — using the stated minimum payment. Link a bill to this debt to model your real budgeted payment.",
  fallback: "No linked bill or stated minimum — assuming 2% of balance (floor $25). Set a minimum or link a bill for a real schedule.",
} as const;

export function DebtLongTermPage() {
  const { lens, month, q } = useCtx();
  const theme = useUi((s) => s.theme);
  const [strategy, setStrategy] = useState<"avalanche" | "snowball">("avalanche");
  const [extra, setExtra] = useState(0);
  const [extraLive, setExtraLive] = useState(0);
  const [editing, setEditing] = useState<DebtDraft | null>(null);

  const view = useApi<LongTermDebtView>(["debts.long", lens, month], `/api/debts/long-term${q}`);
  const payoff = useApi<PayoffPlan>(["debts.payoff", lens, strategy, extra], `/api/debts/payoff${q}&strategy=${strategy}&extra=${extra}`);
  const comparison = useApi<StrategyComparison>(["debts.compare", lens, extra], `/api/debts/compare${q}&extra=${extra}`);
  const { save, payOff } = useDebtActions();

  const mountainOption = useMemo<EChartsOption>(() => {
    const p = payoff.data;
    if (!p) return {};
    const base = chartBase(cssVar("--ink"), cssVar("--ink-muted"), cssVar("--line"));
    const colors = palette();
    return {
      ...base,
      legend: { textStyle: { color: cssVar("--ink-muted"), fontSize: 11 }, top: 0 },
      xAxis: { type: "category", data: p.months.map((m) => monthShort(m) + (m.endsWith("-01") ? ` '${m.slice(2, 4)}` : "")), ...base.xAxis },
      yAxis: { type: "value", ...base.yAxis },
      series: p.perDebt.map((d, i) => ({
        name: d.name, type: "line" as const, stack: "debt", symbol: "none", smooth: 0.2,
        lineStyle: { width: 0 },
        areaStyle: { color: colors[i % colors.length], opacity: 0.7 },
        emphasis: { focus: "series" as const },
        data: d.balances.map((b) => Math.round(b)),
      })),
    };
  }, [payoff.data, theme]);

  const v = view.data;
  const lastPayoff = v?.debts.reduce<string | null>((acc, d) => (d.schedule && (!acc || d.schedule.payoffMonth > acc) ? d.schedule.payoffMonth : acc), null);
  const cmp = comparison.data;

  return (
    <div className="page col" style={{ gap: 20 }}>
      <div className="spread">
        <div>
          <div className="h1">Long-term debt</div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>Installment loans — the schedule runs on the amount your budget sets to pay each one off.</div>
        </div>
        <button className="btn" onClick={() => setEditing({ name: "", kind: "auto_loan", currentBalance: 0, apr: 6.5, minPayment: null, personId: null })}>+ Add debt</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16 }}>
        {[
          { label: "Long-term balance", v: fmt(v?.totalBalance), color: "var(--danger)" },
          { label: "Payments / mo", v: fmt(v?.totalMonthlyPayment), color: "var(--ink)", tip: "Sum of budgeted payments: recurring bills linked to each debt, else the stated minimum." },
          { label: "Interest over repayment", v: fmt(v?.totalInterest), color: "var(--warn)", tip: "Total interest paid over the whole course of repayment, at the current budgeted payments. The length of each schedule follows from the balance, the rate, and that payment." },
          { label: "Last payoff", v: lastPayoff ? monthLabel(lastPayoff) : "—", color: "var(--accent)" },
        ].map((k) => (
          <Card key={k.label} style={{ padding: "16px 18px" }}>
            <div className="label">{k.label}{"tip" in k && k.tip ? <Tip below text={k.tip as string} /> : null}</div>
            <div className="num" style={{ fontSize: 24, fontWeight: 600, marginTop: 5, color: k.color }}>{k.v}</div>
          </Card>
        ))}
      </div>

      <Card style={{ padding: 8 }}>
        <div className="spread" style={{ padding: "12px 16px 10px" }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>Loans<Tip text="Each schedule amortizes the balance at its APR under the budgeted monthly payment — how long repayment takes, and what the interest costs over the whole course." /></div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1.3fr 105px 70px 130px 90px 100px 115px 96px", gap: 12, padding: "4px 16px 8px" }} className="tablehead">
          <div>Name</div>
          <div style={{ textAlign: "right" }}>Balance</div>
          <div style={{ textAlign: "right" }}>APR</div>
          <div style={{ textAlign: "right" }}>Payment / mo</div>
          <div style={{ textAlign: "right" }}>Time left</div>
          <div style={{ textAlign: "right" }}>Payoff</div>
          <div style={{ textAlign: "right" }}>Interest (course)</div>
          <div />
        </div>
        {(v?.debts ?? []).map((d) => (
          <div key={d.debt_id} className="hoverable" style={{ display: "grid", gridTemplateColumns: "1.3fr 105px 70px 130px 90px 100px 115px 96px", gap: 12, padding: "10px 16px", alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{d.name}</div>
              <div className="muted" style={{ fontSize: 11 }}>{d.kind.replace(/_/g, " ")}</div>
            </div>
            <div className="num" style={{ fontSize: 13, fontWeight: 600, textAlign: "right", color: "var(--danger)" }}>{fmtC(d.current_balance)}</div>
            <div className="num" style={{ fontSize: 12.5, textAlign: "right" }}>{d.apr.toFixed(2)}%</div>
            <div style={{ textAlign: "right" }}>
              <div className="num" style={{ fontSize: 12.5, fontWeight: 600 }}>{fmtC(d.budgetedPayment)}</div>
              <span className="muted" style={{ fontSize: 10 }} title={SOURCE_TIP[d.paymentSource]}>{SOURCE_LABEL[d.paymentSource]}</span>
            </div>
            {d.schedule ? (
              <>
                <div className="num" style={{ fontSize: 12.5, textAlign: "right" }}>{timeLeft(d.schedule.monthsToFree)}</div>
                <div className="num" style={{ fontSize: 12.5, textAlign: "right" }}>{monthShort(d.schedule.payoffMonth)} '{d.schedule.payoffMonth.slice(2, 4)}</div>
                <div className="num" style={{ fontSize: 12.5, fontWeight: 600, textAlign: "right", color: "var(--warn)" }}>{fmtC(d.schedule.totalInterest)}</div>
              </>
            ) : (
              <div style={{ gridColumn: "span 3", textAlign: "right" }}>
                <span className="chip" style={{ background: "color-mix(in srgb, var(--danger) 12%, transparent)", color: "var(--danger)", fontSize: 11 }}
                  title="The budgeted payment doesn't cover the monthly interest — the balance never shrinks. Raise the payment or link a bigger bill.">
                  payment too small
                </span>
              </div>
            )}
            <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
              <span className="link" style={{ fontSize: 12 }} onClick={() => setEditing(toDraft(d))}>edit</span>
              <span className="link" style={{ fontSize: 12, color: "var(--gold)" }} onClick={() => payOff.mutate(d.debt_id)}>paid off</span>
            </div>
          </div>
        ))}
        {v?.debts.length === 0 && <EmptyState text="No long-term loans tracked — add one, or re-kind a debt from the short-term screen." />}
      </Card>

      <Card>
        <div className="spread" style={{ marginBottom: 6, flexWrap: "wrap", gap: 12 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Payoff mountain — all debts<Tip text="Projected balances stacked per debt (short-term included), melting to zero. Avalanche pays highest-APR first (cheapest); snowball pays smallest balance first (quickest wins). The extra slider adds monthly money on top of all minimums." /></div>
            {cmp && (
              <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
                Avalanche is debt-free <b style={{ color: "var(--accent)" }}>{cmp.monthsSaved} month{cmp.monthsSaved === 1 ? "" : "s"} sooner</b> and saves <b style={{ color: "var(--accent)" }}>{fmt(cmp.interestSaved)}</b> in interest vs. snowball
              </div>
            )}
          </div>
          <div className="row" style={{ gap: 14 }}>
            <div className="col" style={{ gap: 3, width: 220 }}>
              <div className="spread muted" style={{ fontSize: 11 }}>
                <span>Extra payment</span><b className="num" style={{ color: "var(--accent)" }}>{fmt(extraLive)}/mo</b>
              </div>
              <input type="range" min={0} max={2000} step={25} value={extraLive}
                onChange={(e) => setExtraLive(Number(e.target.value))}
                onMouseUp={() => setExtra(extraLive)} onTouchEnd={() => setExtra(extraLive)}
                style={{ accentColor: "var(--accent)" }} />
            </div>
            <Seg subtle value={strategy} onChange={setStrategy} items={[{ key: "avalanche" as const, label: "Avalanche" }, { key: "snowball" as const, label: "Snowball" }]} />
          </div>
        </div>
        <Chart option={mountainOption} height={330} />
      </Card>

      {editing && (
        <Modal title={editing.debtId ? "Edit debt" : "Add debt"} onClose={() => setEditing(null)}>
          <DebtForm initial={editing} submitLabel={editing.debtId ? "Save" : "Add debt"} onSubmit={(d) => { save.mutate(d); setEditing(null); }} />
        </Modal>
      )}
    </div>
  );
}
