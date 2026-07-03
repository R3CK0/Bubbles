import { useMemo, useState } from "react";
import { useApi, useCtx } from "../api/hooks";
import type { BudgetView, CashflowSummary, CategoryDrilldown, FluxMatrix, IncomeBreakdown, SankeyGraph } from "../api/types";
import { Card, Seg } from "../components/ui";
import { Tip } from "../components/Tip";
import { Chart, chartBase, EChartsOption } from "../components/Chart";
import { cssVar, dayLabel, fmt, fmtDelta, fmtPct, monthLabel, monthShort, palette } from "../lib/format";
import { useUi } from "../stores/ui";

const HOUSEHOLD = "Household";

function pieOption(slices: { name: string; value: number }[], colors: string[]): EChartsOption {
  return {
    tooltip: { trigger: "item", valueFormatter: (v) => fmt(v as number) },
    series: [{
      type: "pie", radius: ["52%", "78%"], center: ["50%", "50%"],
      startAngle: 90,
      itemStyle: { borderColor: cssVar("--surface"), borderWidth: 2, borderRadius: 5 },
      label: { show: false },
      data: slices.map((s, i) => ({ ...s, itemStyle: { color: colors[i % colors.length] } })),
    }],
  };
}

export function CashFlow() {
  const { lens, month, q } = useCtx();
  const theme = useUi((s) => s.theme);
  const [matrixMode, setMatrixMode] = useState<"actuals" | "variance">("variance");
  const [drill, setDrill] = useState<{ categoryId: string; name: string } | null>(null);
  const [incomeOpen, setIncomeOpen] = useState(false);

  const summary = useApi<CashflowSummary>(["cashflow.summary", lens, month], `/api/cashflow/summary${q}`);
  const sankey = useApi<SankeyGraph>(["cashflow.sankey", lens, month], `/api/cashflow/sankey${q}`);
  const flux = useApi<FluxMatrix>(["cashflow.flux", lens], `/api/cashflow/flux${q}&months=12`);
  const budget = useApi<BudgetView>(["budget.view", lens, month], `/api/budget${q}`);
  const drilldown = useApi<CategoryDrilldown>(
    ["cashflow.category", drill?.categoryId ?? "", lens, month],
    drill ? `/api/cashflow/category/${encodeURIComponent(drill.categoryId)}${q}` : null,
  );
  const incomeDetail = useApi<IncomeBreakdown>(
    ["cashflow.income", lens, month],
    incomeOpen ? `/api/cashflow/income${q}` : null,
  );

  const colors = useMemo(() => palette(), [theme]);
  const s = summary.data;
  const savingsRate = s && s.income > 0 ? s.net / s.income : null;

  // pies come from the sankey: in-links feed Household, out-links leave it
  const inSlices = useMemo(
    () => (sankey.data?.links ?? []).filter((l) => l.target === HOUSEHOLD).map((l) => ({ name: l.source, value: l.value })).sort((a, b) => b.value - a.value),
    [sankey.data],
  );
  const outSlices = useMemo(
    () => (sankey.data?.links ?? []).filter((l) => l.source === HOUSEHOLD && l.target !== "Unallocated").map((l) => ({ name: l.target, value: l.value })).sort((a, b) => b.value - a.value),
    [sankey.data],
  );
  const inTotal = inSlices.reduce((t, x) => t + x.value, 0);
  const outTotal = outSlices.reduce((t, x) => t + x.value, 0);

  // budget lookup for out-legend variance chips + variance matrix
  const budgetByCat = useMemo(() => {
    const m = new Map<string, { budget: number; variance: number }>();
    for (const r of budget.data?.rows ?? []) m.set(r.categoryId, { budget: r.budget, variance: r.variance });
    return m;
  }, [budget.data]);
  const catIdByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of flux.data?.categories ?? []) m.set(c.name, c.categoryId);
    return m;
  }, [flux.data]);

  const matrixOption = useMemo<EChartsOption>(() => {
    const f = flux.data;
    if (!f) return {};
    const cats = f.categories.filter((c) => c.kind === "expense");
    const cellMap = new Map(f.cells.map((c) => [`${c.month}|${c.categoryId}`, c.value]));
    const data: [number, number, number][] = [];
    let maxAbs = 1;
    cats.forEach((c, y) => {
      f.months.forEach((m, x) => {
        const actual = cellMap.get(`${m}|${c.categoryId}`) ?? 0;
        const b = budgetByCat.get(c.categoryId)?.budget ?? 0;
        const v = matrixMode === "actuals" ? actual : actual - b;
        maxAbs = Math.max(maxAbs, Math.abs(v));
        data.push([x, y, Math.round(v)]);
      });
    });
    const base = chartBase(cssVar("--ink"), cssVar("--ink-muted"), cssVar("--line"));
    return {
      ...base,
      tooltip: {
        ...base.tooltip, trigger: "item",
        formatter: (p: unknown) => {
          const d = (p as { value: [number, number, number] }).value;
          const cat = cats[d[1]];
          const m = f.months[d[0]];
          return `<b>${cat?.name}</b> · ${monthLabel(m)}<br/>${matrixMode === "actuals" ? "Spent" : "vs budget"}: ${fmt(d[2])}`;
        },
      },
      grid: { left: 8, right: 60, top: 8, bottom: 28, containLabel: true },
      xAxis: { type: "category", data: f.months.map(monthShort), ...base.xAxis, splitArea: { show: false } },
      yAxis: { type: "category", data: cats.map((c) => c.name), axisLabel: { color: cssVar("--ink-muted"), fontSize: 11 }, splitLine: { show: false } },
      visualMap: {
        min: matrixMode === "actuals" ? 0 : -maxAbs, max: maxAbs, calculable: false,
        orient: "vertical", right: 0, top: "center", itemHeight: 120,
        textStyle: { color: cssVar("--ink-muted"), fontSize: 10 },
        inRange: {
          color: matrixMode === "actuals"
            ? [cssVar("--surface-2"), cssVar("--accent")]
            : [cssVar("--accent"), cssVar("--surface-2"), cssVar("--warn")],
        },
      },
      series: [{
        type: "heatmap", data,
        label: { show: true, fontSize: 9.5, color: cssVar("--ink"), formatter: (p: { value: [number, number, number] }) => (Math.abs(p.value[2]) >= 1 ? `${p.value[2] >= 0 ? "" : "−"}${Math.round(Math.abs(p.value[2]) / (matrixMode === "actuals" ? 1 : 1)).toLocaleString()}` : "") },
        itemStyle: { borderColor: cssVar("--surface"), borderWidth: 2, borderRadius: 4 },
        emphasis: { itemStyle: { shadowBlur: 8, shadowColor: "rgba(0,0,0,.4)" } },
      }],
    };
  }, [flux.data, budgetByCat, matrixMode, theme]);

  const kpis = s ? [
    { label: "Money in", v: fmt(s.income), color: "var(--accent)" },
    { label: "Money out", v: fmt(s.spend), color: "var(--ink)" },
    { label: "Net", v: fmt(s.net), color: s.net >= 0 ? "var(--accent)" : "var(--danger)" },
    { label: "Savings rate", v: fmtPct(savingsRate), color: (savingsRate ?? 0) >= 0.1 ? "var(--accent)" : "var(--warn)", tip: "Net ÷ income for the month — the share of after-tax income you kept." },
  ] : [];

  return (
    <div className="page col" style={{ gap: 20 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16 }}>
        {kpis.map((k) => (
          <Card key={k.label} style={{ padding: "16px 18px" }}>
            <div className="label">{k.label}{"tip" in k && k.tip ? <Tip below text={k.tip as string} /> : null}</div>
            <div className="num" style={{ fontSize: 24, fontWeight: 600, marginTop: 5, color: k.color }}>{k.v}</div>
          </Card>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <Card style={{ padding: "22px 24px", cursor: "pointer" }} onClick={() => setIncomeOpen(true)}>
          <div className="spread" style={{ alignItems: "baseline" }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Money in<Tip text="Income by source for the month: each person's pay plus named streams like Buildings. Reimbursement deposits flagged 'work pays' are excluded. Click for the account-level breakdown." /></div>
            <div className="num" style={{ fontSize: 18, fontWeight: 600, color: "var(--accent)" }}>{fmt(inTotal)}</div>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{monthLabel(month)} · income by source · click for account detail</div>
          <Chart option={pieOption(inSlices, colors)} height={210} />
          <div className="col" style={{ gap: 9, marginTop: 6 }}>
            {inSlices.map((x, i) => (
              <div key={x.name} className="row hoverable" style={{ gap: 10, padding: "3px 5px" }}>
                <span style={{ flex: "none", width: 11, height: 11, borderRadius: 3, background: colors[i % colors.length] }} />
                <div style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 500 }}>{x.name}</div>
                <div className="muted num" style={{ fontSize: 12, minWidth: 40, textAlign: "right" }}>{inTotal ? `${Math.round((x.value / inTotal) * 100)}%` : ""}</div>
                <div className="num" style={{ fontSize: 13.5, fontWeight: 600, minWidth: 78, textAlign: "right" }}>{fmt(x.value)}</div>
              </div>
            ))}
          </div>
        </Card>

        <Card style={{ padding: "22px 24px" }}>
          <div className="spread" style={{ alignItems: "baseline" }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Money out<Tip text="Spending by top-level category. Transfers between your own accounts, reimbursed expenses, and goal-tagged spending are excluded. Click a row for the transaction drill-down." /></div>
            <div className="num" style={{ fontSize: 18, fontWeight: 600 }}>{fmt(outTotal)}</div>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{monthLabel(month)} · spending by category · click a row for detail</div>
          <Chart option={pieOption(outSlices, colors)} height={210} />
          <div className="col" style={{ gap: 7, marginTop: 6, maxHeight: 170, overflowY: "auto" }}>
            {outSlices.map((x, i) => {
              const catId = catIdByName.get(x.name);
              const b = catId ? budgetByCat.get(catId) : undefined;
              return (
                <div key={x.name} className="row hoverable" style={{ gap: 10, padding: "3px 5px", cursor: catId ? "pointer" : "default" }}
                  onClick={() => catId && setDrill({ categoryId: catId, name: x.name })}>
                  <span style={{ flex: "none", width: 11, height: 11, borderRadius: 3, background: colors[i % colors.length] }} />
                  <div style={{ flex: 1, minWidth: 0, fontSize: 13.5, fontWeight: 500 }}>{x.name}</div>
                  {b && b.budget > 0 && (
                    <div className="num" style={{ fontSize: 11, fontWeight: 600, minWidth: 60, textAlign: "right", color: b.variance > 0 ? "var(--warn)" : "var(--accent)" }}>
                      {fmtDelta(b.variance)}
                    </div>
                  )}
                  <div className="num" style={{ fontSize: 13.5, fontWeight: 600, minWidth: 74, textAlign: "right" }}>{fmt(x.value)}</div>
                </div>
              );
            })}
          </div>
        </Card>
      </div>

      <Card style={{ padding: "22px 24px" }}>
        <div className="spread" style={{ alignItems: "flex-start", marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>Flux matrix<Tip text="Twelve months × category. In 'vs Budget' mode each cell is actual spend minus your current budget line — green under, amber over. 'Actuals' shows raw spend. Click any cell to drill into its transactions and variance drivers." /></div>
            <div className="muted" style={{ fontSize: 12 }}>
              12 months × category · {matrixMode === "variance" ? <>variance vs current budget — <span style={{ color: "var(--accent)" }}>green under</span>, <span style={{ color: "var(--warn)" }}>amber over</span></> : "actual spend"} · click a cell for detail
            </div>
          </div>
          <Seg subtle items={[{ key: "actuals" as const, label: "Actuals" }, { key: "variance" as const, label: "vs Budget" }]} value={matrixMode} onChange={setMatrixMode} />
        </div>
        <Chart option={matrixOption} height={Math.max(300, 34 * (flux.data?.categories.filter((c) => c.kind === "expense").length ?? 8))}
          onClick={(p) => {
            if (p.componentSubType !== "heatmap") return;
            const v = p.value as [number, number, number];
            const cats = (flux.data?.categories ?? []).filter((c) => c.kind === "expense");
            const cat = cats[v[1]];
            if (cat) setDrill({ categoryId: cat.categoryId, name: cat.name });
          }} />
      </Card>

      {incomeOpen && (
        <div className="drawer" onClick={(e) => e.stopPropagation()}>
          <div className="spread" style={{ padding: "18px 20px", borderBottom: "1px solid var(--line)" }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>Income breakdown</div>
              <div className="muted" style={{ fontSize: 12 }}>{monthLabel(month)} · {fmt(incomeDetail.data?.total)} · by source and receiving account</div>
            </div>
            <div style={{ cursor: "pointer", fontSize: 20, color: "var(--ink-muted)" }} onClick={() => setIncomeOpen(false)}>×</div>
          </div>
          <div style={{ padding: 20 }} className="col">
            {(incomeDetail.data?.sources ?? []).map((src) => (
              <div key={src.name} style={{ marginBottom: 18 }}>
                <div className="spread" style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 14, fontWeight: 600 }}>{src.name}</div>
                  <div className="num" style={{ fontSize: 14, fontWeight: 600, color: "var(--accent)" }}>{fmt(src.total)}</div>
                </div>
                <div className="col" style={{ gap: 8 }}>
                  {src.accounts.map((acc) => (
                    <div key={acc.accountId} className="panel" style={{ padding: "10px 12px" }}>
                      <div className="spread" style={{ marginBottom: acc.deposits.length ? 6 : 0 }}>
                        <span style={{ fontSize: 12.5, fontWeight: 600 }}>
                          🏦 {acc.accountName}{acc.mask && <span className="muted num" style={{ marginLeft: 6, fontSize: 11 }}>····{acc.mask}</span>}
                        </span>
                        <span className="num" style={{ fontSize: 12.5, fontWeight: 600 }}>{fmt(acc.amount)}</span>
                      </div>
                      {acc.deposits.map((d) => (
                        <div key={d.transactionId} className="spread muted" style={{ fontSize: 11.5, padding: "2px 0" }}>
                          <span>{dayLabel(d.date)}{d.merchant && <span style={{ marginLeft: 6 }}>{d.merchant}</span>}</span>
                          <span className="num">{fmt(d.amount)}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {incomeDetail.data && incomeDetail.data.sources.length === 0 && <div className="empty">No income recorded this month</div>}
            {!incomeDetail.data && <div className="empty">Loading…</div>}
          </div>
        </div>
      )}

      {drill && (
        <div className="drawer" onClick={(e) => e.stopPropagation()}>
          <div className="spread" style={{ padding: "18px 20px", borderBottom: "1px solid var(--line)" }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{drill.name}</div>
              <div className="muted" style={{ fontSize: 12 }}>{monthLabel(month)} · {fmt(drilldown.data?.total)}</div>
            </div>
            <div style={{ cursor: "pointer", fontSize: 20, color: "var(--ink-muted)" }} onClick={() => setDrill(null)}>×</div>
          </div>
          <div style={{ padding: 20 }}>
            {(drilldown.data?.drivers.length ?? 0) > 0 && (
              <div className="panel" style={{ padding: 12, marginBottom: 14 }}>
                {drilldown.data!.drivers.map((d, i) => (
                  <div key={i} className="row" style={{ gap: 8, padding: "4px 0", fontSize: 12 }}>
                    <span className="chip chip-accent">{d.kind.replace(/_/g, " ")}</span>
                    <span style={{ flex: 1 }}>{d.detail}</span>
                    <span className="num" style={{ fontWeight: 600, color: d.delta > 0 ? "var(--warn)" : "var(--accent)" }}>{fmtDelta(d.delta)}</span>
                  </div>
                ))}
              </div>
            )}
            {(drilldown.data?.trend.length ?? 0) > 1 && (
              <Chart height={110} option={{
                ...chartBase(cssVar("--ink"), cssVar("--ink-muted"), cssVar("--line")),
                grid: { left: 4, right: 8, top: 8, bottom: 4, containLabel: true },
                xAxis: { type: "category", data: drilldown.data!.trend.map((t) => monthShort(t.month)), axisLabel: { color: cssVar("--ink-muted"), fontSize: 10 } },
                yAxis: { type: "value", splitLine: { lineStyle: { color: cssVar("--line") } }, axisLabel: { show: false } },
                series: [{ type: "bar", data: drilldown.data!.trend.map((t) => Math.round(t.value)), itemStyle: { color: cssVar("--accent"), borderRadius: 3 }, barWidth: "55%" }],
              }} />
            )}
            <div className="col" style={{ marginTop: 12 }}>
              {(drilldown.data?.transactions ?? []).map((t) => (
                <div key={t.transactionId} className="row" style={{ padding: "8px 0", borderBottom: "1px solid var(--line)", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.merchant ?? "—"}{t.pending && <span className="chip" style={{ marginLeft: 6 }}>pending</span>}</div>
                    <div className="muted" style={{ fontSize: 11 }}>{dayLabel(t.date)}</div>
                  </div>
                  <div className="num" style={{ fontSize: 13, fontWeight: 600 }}>{fmt(Math.abs(t.amount))}</div>
                </div>
              ))}
              {drilldown.data && drilldown.data.transactions.length === 0 && <div className="empty">No transactions this month</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
