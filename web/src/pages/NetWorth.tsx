import { useMemo, useRef, useState } from "react";
import { useApi, useCtx } from "../api/hooks";
import { api } from "../api/client";
import type { BreakdownEntry, EmergencyFund, NetWorthSeries } from "../api/types";
import { Card, Seg } from "../components/ui";
import { Tip } from "../components/Tip";
import { Chart, chartBase, EChartsOption } from "../components/Chart";
import { cssVar, dayLabel, fmt } from "../lib/format";
import { useUi } from "../stores/ui";

const RANGES = [{ key: "90", label: "3M" }, { key: "365", label: "1Y" }, { key: "3650", label: "All" }] as const;

export function NetWorth() {
  const { lens, q } = useCtx();
  const theme = useUi((s) => s.theme);
  const [days, setDays] = useState<"90" | "365" | "3650">("365");
  const [breakdown, setBreakdown] = useState<{ date: string; entries: BreakdownEntry[] } | null>(null);
  const pending = useRef<string | null>(null);

  const series = useApi<NetWorthSeries>(["networth.series", lens, days], `/api/networth${q}&days=${days}`);
  const ef = useApi<EmergencyFund>(["networth.ef", lens], `/api/networth/emergency-fund${q}`);

  const fetchBreakdown = (date: string) => {
    if (pending.current === date) return;
    pending.current = date;
    api<{ breakdown: BreakdownEntry[] }>(`/api/networth/breakdown${q}&date=${date}`)
      .then((r) => { if (pending.current === date) setBreakdown({ date, entries: r.breakdown }); })
      .catch(() => undefined);
  };

  const option = useMemo<EChartsOption>(() => {
    const s = series.data;
    if (!s) return {};
    const base = chartBase(cssVar("--ink"), cssVar("--ink-muted"), cssVar("--line"));
    return {
      ...base,
      legend: { textStyle: { color: cssVar("--ink-muted"), fontSize: 11 }, top: 0 },
      xAxis: { type: "category", data: s.dates, axisLabel: { color: cssVar("--ink-muted"), fontSize: 10, formatter: (v: string) => v.slice(5) }, axisLine: { lineStyle: { color: cssVar("--line") } }, axisTick: { show: false } },
      yAxis: { type: "value", ...base.yAxis },
      series: [
        { name: "Assets", type: "line", symbol: "none", smooth: 0.15, data: s.assets.map((p) => Math.round(p.value)), lineStyle: { width: 0 }, areaStyle: { color: cssVar("--accent"), opacity: 0.25 } },
        { name: "Debts", type: "line", symbol: "none", smooth: 0.15, data: s.debts.map((p) => -Math.round(p.value)), lineStyle: { width: 0 }, areaStyle: { color: cssVar("--danger"), opacity: 0.3 } },
        {
          name: "Net", type: "line", symbol: "none", smooth: 0.15, data: s.net.map((p) => Math.round(p.value)),
          lineStyle: { color: cssVar("--accent"), width: 2.5 },
          markPoint: {
            symbol: "pin", symbolSize: 34,
            itemStyle: { color: cssVar("--gold") },
            label: { fontSize: 8, color: "#1A201E", formatter: () => "⚑" },
            data: s.milestones.map((m) => ({ coord: [m.date, Math.round(m.value)] })),
          },
        },
      ],
    };
  }, [series.data, theme]);

  const months = ef.data?.months ?? null;
  const efColor = months === null ? "var(--ink-muted)" : months >= 3 ? "var(--accent)" : months >= 1.5 ? "var(--warn)" : "var(--danger)";

  return (
    <div className="page" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 300px", gap: 20 }}>
      <Card>
        <div className="spread" style={{ marginBottom: 8 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Net worth<Tip text="Assets fill above the axis, debts mirror below, and the net line threads between. Gold flags are record highs. Hover any point for the day's account-level breakdown." /></div>
            <div className="muted" style={{ fontSize: 12 }}>assets above the line, debts mirrored below · gold flags are records · hover for the day's breakdown</div>
          </div>
          <Seg subtle value={days} onChange={setDays} items={RANGES.map((r) => ({ key: r.key, label: r.label }))} />
        </div>
        <Chart option={option} height={380} onHover={(p) => {
          const date = series.data?.dates[p.dataIndex ?? -1];
          if (date) fetchBreakdown(date);
        }} />
      </Card>

      <div className="col" style={{ gap: 16 }}>
        <Card>
          <div className="label" style={{ marginBottom: 10 }}>Emergency fund<Tip text="Liquid balances ÷ average monthly essentials = months of runway if income stopped. Aim for the 6-month target; the color turns amber below ~1.5 months of slack." /></div>
          <div className="num" style={{ fontSize: 34, fontWeight: 600, color: efColor }}>
            {months === null ? "—" : `${months.toFixed(1)} mo`}
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 6, lineHeight: 1.5 }}>
            {fmt(ef.data?.liquidBalance)} liquid ÷ {fmt(ef.data?.essentialsMonthlyAvg)}/mo essentials
          </div>
          <div className="bar-track" style={{ marginTop: 10 }}>
            <div className="bar-fill" style={{ width: `${Math.min(100, ((months ?? 0) / 6) * 100)}%`, background: efColor }} />
          </div>
          <div className="muted" style={{ fontSize: 10.5, marginTop: 4, textAlign: "right" }}>target 6 months</div>
        </Card>

        <Card>
          <div className="label" style={{ marginBottom: 10 }}>
            {breakdown ? `Breakdown · ${dayLabel(breakdown.date)}` : "Breakdown — hover the chart"}
          </div>
          {breakdown && (
            <div className="col" style={{ gap: 6 }}>
              {breakdown.entries.map((e, i) => (
                <div key={i} className="spread" style={{ fontSize: 12.5 }}>
                  <span className="row" style={{ gap: 6 }}>
                    <span className="dot" style={{ width: 7, height: 7, background: e.liability ? "var(--danger)" : e.kind === "manual_asset" ? "var(--gold)" : "var(--accent)" }} />
                    {e.label}
                  </span>
                  <b className="num" style={{ color: e.liability ? "var(--danger)" : "var(--ink)" }}>{e.liability ? "−" : ""}{fmt(Math.abs(e.value))}</b>
                </div>
              ))}
              <div className="spread" style={{ fontSize: 13, fontWeight: 700, marginTop: 6, paddingTop: 8, borderTop: "1px solid var(--line)" }}>
                <span>Net</span>
                <span className="num">{fmt(breakdown.entries.reduce((t, e) => t + (e.liability ? -Math.abs(e.value) : e.value), 0))}</span>
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
