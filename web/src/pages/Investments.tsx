import { useEffect, useMemo, useState } from "react";
import { useAction, useApi, useCtx } from "../api/hooks";
import { api } from "../api/client";
import type { AccountPositions, AllocationSlice, BuildingsPnl, Holding, ManualAsset, Performance, PortfolioSeries, Position } from "../api/types";
import { Card, EmptyState, Field, Modal, Seg, Spark, Spinner } from "../components/ui";
import { Tip } from "../components/Tip";
import { Chart, chartBase, EChartsOption } from "../components/Chart";
import { cssVar, fmt, fmtC, fmtPct, monthShort, palette } from "../lib/format";
import { useUi } from "../stores/ui";

const ASSET_TYPES = ["stock", "etf", "crypto", "option", "cash", "other"] as const;

interface PosDraft {
  positionId?: string; accountId: string; symbol: string; name: string;
  assetType: (typeof ASSET_TYPES)[number]; quantity: number; bookCost: number | null; manualValue: number | null;
}

export function Investments() {
  const { lens, month, q } = useCtx();
  const theme = useUi((s) => s.theme);
  const [decompose, setDecompose] = useState<"value" | "split">("value");
  const [editorOpen, setEditorOpen] = useState(false);
  const [posDraft, setPosDraft] = useState<PosDraft | null>(null);
  const [targetsOpen, setTargetsOpen] = useState(false);
  const [revalue, setRevalue] = useState<ManualAsset | null>(null);

  const series = useApi<PortfolioSeries>(["portfolio.series", lens, decompose], `/api/portfolio/series${q}&days=365&decompose=${decompose === "split"}`);
  const holdings = useApi<{ holdings: Holding[] }>(["portfolio.holdings", lens], `/api/portfolio/holdings${q}`);
  const allocation = useApi<{ allocation: AllocationSlice[] }>(["portfolio.allocation", lens], `/api/portfolio/allocation${q}`);
  const performance = useApi<Performance>(["portfolio.performance", lens], `/api/portfolio/performance${q}&days=365`);
  const positions = useApi<{ accounts: AccountPositions[] }>(["positions", lens], `/api/positions${q}`);
  const assets = useApi<{ assets: ManualAsset[] }>(["portfolio.assets"], "/api/assets");
  const buildings = useApi<BuildingsPnl>(["portfolio.buildings", lens, month], `/api/portfolio/buildings${q}`);

  const savePos = useAction(
    (d: PosDraft) => {
      const body = { accountId: d.accountId, symbol: d.symbol || null, name: d.name, assetType: d.assetType, quantity: d.quantity, bookCost: d.bookCost, manualValue: d.manualValue };
      return d.positionId
        ? api(`/api/positions/${d.positionId}`, { method: "PATCH", json: body })
        : api("/api/positions", { method: "POST", json: body });
    },
    ["positions", "portfolio", "networth", "overview"],
  );
  const deletePos = useAction((id: string) => api(`/api/positions/${id}`, { method: "DELETE" }), ["positions", "portfolio", "networth"]);
  const refresh = useAction(() => api("/api/positions/refresh", { method: "POST", json: {} }), ["positions", "portfolio", "networth", "overview"]);
  const saveTargets = useAction((t: Record<string, number>) => api("/api/portfolio/targets", { method: "PUT", json: t }), ["portfolio"]);
  const addValuation = useAction(
    (a: { assetId: string; value: number }) => api(`/api/assets/${a.assetId}/valuations`, { method: "POST", json: { date: new Date().toISOString().slice(0, 10), value: a.value, source: "manual revalue" } }),
    ["portfolio", "networth", "overview"],
  );

  // symbol validation (debounced)
  const [symbolCheck, setSymbolCheck] = useState<{ ok: boolean; msg: string } | null>(null);
  useEffect(() => {
    if (!posDraft?.symbol) { setSymbolCheck(null); return; }
    const t = setTimeout(() => {
      api<{ valid?: boolean; ok?: boolean; name?: string; price?: number; error?: string }>(`/api/positions/validate/${encodeURIComponent(posDraft.symbol)}`)
        .then((r) => {
          const ok = (r.valid ?? r.ok ?? false) as boolean;
          setSymbolCheck({ ok, msg: ok ? `✓ ${r.name ?? posDraft.symbol}` : "not found — TSX tickers need .TO" });
        })
        .catch(() => setSymbolCheck({ ok: false, msg: "validation unavailable" }));
    }, 450);
    return () => clearTimeout(t);
  }, [posDraft?.symbol]);

  const seriesOption = useMemo<EChartsOption>(() => {
    const s = series.data;
    if (!s) return {};
    const base = chartBase(cssVar("--ink"), cssVar("--ink-muted"), cssVar("--line"));
    const x = s.series.map((p) => p.date);
    const common = { type: "line" as const, symbol: "none" as const, smooth: 0.15 };
    return {
      ...base,
      legend: { textStyle: { color: cssVar("--ink-muted"), fontSize: 11 }, top: 0 },
      xAxis: { type: "category", data: x, axisLabel: { color: cssVar("--ink-muted"), fontSize: 10, formatter: (v: string) => v.slice(5) }, axisLine: { lineStyle: { color: cssVar("--line") } }, axisTick: { show: false } },
      yAxis: { type: "value", ...base.yAxis },
      series: decompose === "split" && s.decomposition
        ? [
            { ...common, name: "Contributions", stack: "v", data: s.decomposition.contributions.map((p) => Math.round(p.value)), lineStyle: { width: 0 }, areaStyle: { color: cssVar("--ink-muted"), opacity: 0.35 } },
            { ...common, name: "Market growth", stack: "v", data: s.decomposition.growth.map((p) => Math.round(p.value)), lineStyle: { width: 0 }, areaStyle: { color: cssVar("--accent"), opacity: 0.4 } },
          ]
        : [{ ...common, name: "Portfolio", data: s.series.map((p) => Math.round(p.value)), lineStyle: { color: cssVar("--accent"), width: 2.5 }, areaStyle: { color: cssVar("--accent"), opacity: 0.1 } }],
    };
  }, [series.data, decompose, theme]);

  const allocOption = useMemo<EChartsOption>(() => {
    const a = allocation.data?.allocation ?? [];
    const colors = palette();
    return {
      tooltip: { trigger: "item", valueFormatter: (v) => fmt(v as number) },
      series: [
        { type: "pie", radius: ["30%", "48%"], label: { show: false }, itemStyle: { borderColor: cssVar("--surface"), borderWidth: 2 }, data: a.map((s, i) => ({ name: `${s.class} target`, value: Math.round((s.target ?? 0) * a.reduce((t, x) => t + x.value, 0)), itemStyle: { color: colors[i % colors.length], opacity: 0.35 } })) },
        { type: "pie", radius: ["56%", "80%"], label: { show: false }, itemStyle: { borderColor: cssVar("--surface"), borderWidth: 2 }, data: a.map((s, i) => ({ name: s.class, value: Math.round(s.value), itemStyle: { color: colors[i % colors.length] } })) },
      ],
    };
  }, [allocation.data, theme]);

  const buildingsOption = useMemo<EChartsOption>(() => {
    const b = buildings.data;
    if (!b || b.netByMonth.length === 0) return {};
    const base = chartBase(cssVar("--ink"), cssVar("--ink-muted"), cssVar("--line"));
    return {
      ...base,
      xAxis: { type: "category", data: b.netByMonth.map((m) => monthShort(m.month)), ...base.xAxis },
      yAxis: { type: "value", ...base.yAxis },
      series: [{ type: "bar", data: b.netByMonth.map((m) => ({ value: Math.round(m.value), itemStyle: { color: m.value >= 0 ? cssVar("--accent") : cssVar("--danger"), borderRadius: 3 } })), barWidth: "55%" }],
    };
  }, [buildings.data, theme]);

  const totalValue = (positions.data?.accounts ?? []).reduce((t, a) => t + a.computedTotal, 0);

  return (
    <div className="page col" style={{ gap: 20 }}>
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.6fr) minmax(0,1fr)", gap: 20 }}>
        <Card>
          <div className="spread" style={{ marginBottom: 6 }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>Portfolio · {fmt(totalValue)}</div>
              <div className="muted" style={{ fontSize: 12 }}>TWR {fmtPct(performance.data?.twr ?? null, 1)} · MWR {fmtPct(performance.data?.mwr ?? null, 1)} (1y)<Tip text="Time-weighted return measures the investments themselves; money-weighted return includes the timing of your contributions. 'Contributions vs growth' splits the chart into money you added vs what the market did." /></div>
            </div>
            <Seg subtle value={decompose} onChange={setDecompose} items={[{ key: "value" as const, label: "Value" }, { key: "split" as const, label: "Contributions vs growth" }]} />
          </div>
          <Chart option={seriesOption} height={290} />
        </Card>
        <Card>
          <div className="spread">
            <div style={{ fontSize: 15, fontWeight: 600 }}>Allocation<Tip text="Outer ring = actual weights by asset class; inner ring = your targets. Drifted classes get an amber callout — rebalance when it bothers you." /></div>
            <span className="link" style={{ fontSize: 12 }} onClick={() => setTargetsOpen(true)}>set targets</span>
          </div>
          <Chart option={allocOption} height={200} />
          <div className="col" style={{ gap: 6 }}>
            {(allocation.data?.allocation ?? []).map((s) => (
              <div key={s.class} className="spread" style={{ fontSize: 12.5 }}>
                <span>{s.class}</span>
                <span className="row" style={{ gap: 8 }}>
                  <b className="num">{fmtPct(s.weight, 1)}</b>
                  {s.drift !== null && Math.abs(s.drift) > 0.02 && (
                    <span className="num" style={{ fontSize: 11, color: "var(--warn)", fontWeight: 600 }}>{s.drift > 0 ? "+" : ""}{(s.drift * 100).toFixed(1)}% vs target</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card style={{ padding: 8 }}>
        <div className="spread" style={{ padding: "12px 16px 10px" }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Positions <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>(you maintain these — Plaid investments needs production access)</span><Tip text="Enter what each investment account holds: a market symbol + quantity (TSX tickers need .TO), or a manual value for cash. 'Refresh prices' pulls Yahoo daily closes and rebuilds portfolio history. The 'vs bank' chip flags drift between your entries and the reported balance." /></div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn-ghost" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
              {refresh.isPending ? <Spinner /> : "↻"} Refresh prices
            </button>
            <button className="btn-ghost" onClick={() => setEditorOpen((s) => !s)}>{editorOpen ? "Done" : "Edit"}</button>
            <button className="btn" onClick={() => setPosDraft({ accountId: positions.data?.accounts[0]?.accountId ?? "", symbol: "", name: "", assetType: "etf", quantity: 0, bookCost: null, manualValue: null })}>+ Position</button>
          </div>
        </div>
        {(positions.data?.accounts ?? []).map((acct) => (
          <div key={acct.accountId} style={{ padding: "6px 16px 12px" }}>
            <div className="row" style={{ gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 12.5, fontWeight: 700 }}>{acct.accountName ?? acct.accountId}</span>
              {acct.registeredType && <span className="chip chip-accent">{acct.registeredType}</span>}
              <span className="muted num" style={{ fontSize: 12 }}>{fmt(acct.computedTotal)}</span>
              {acct.drift !== null && Math.abs(acct.drift) > 1 && (
                <span className="chip" style={{ background: "color-mix(in srgb, var(--warn) 12%, transparent)", color: "var(--warn)" }} title="entered positions vs the bank's reported balance">
                  {acct.drift > 0 ? "+" : ""}{fmt(acct.drift)} vs bank
                </span>
              )}
            </div>
            {acct.positions.map((p: Position) => (
              <div key={p.position_id} className="hoverable" style={{ display: "grid", gridTemplateColumns: "90px 1.4fr 90px 110px 120px 80px", gap: 12, padding: "7px 10px", alignItems: "center" }}>
                <span className="num" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--accent)" }}>{p.symbol ?? "—"}</span>
                <span style={{ fontSize: 12.5 }}>{p.name}</span>
                <span className="num muted" style={{ fontSize: 12, textAlign: "right" }}>{p.quantity}</span>
                <span className="num muted" style={{ fontSize: 12, textAlign: "right" }}>{p.lastPrice !== null ? fmtC(p.lastPrice) : "manual"}</span>
                <span className="num" style={{ fontSize: 12.5, fontWeight: 600, textAlign: "right" }}>{fmt(p.currentValue)}</span>
                {editorOpen ? (
                  <span className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
                    <span className="link" style={{ fontSize: 11.5 }} onClick={() => setPosDraft({ positionId: p.position_id, accountId: p.account_id, symbol: p.symbol ?? "", name: p.name, assetType: p.asset_type, quantity: p.quantity, bookCost: p.book_cost, manualValue: p.manual_value })}>edit</span>
                    <span style={{ cursor: "pointer", color: "var(--ink-muted)" }} onClick={() => deletePos.mutate(p.position_id)}>×</span>
                  </span>
                ) : <span />}
              </div>
            ))}
          </div>
        ))}
        {positions.data?.accounts.length === 0 && <EmptyState text="No positions yet — add what each investment account holds." />}
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr)", gap: 20 }}>
        <Card style={{ padding: 8 }}>
          <div style={{ padding: "12px 16px 8px", fontSize: 14, fontWeight: 600 }}>Holdings</div>
          <div style={{ display: "grid", gridTemplateColumns: "80px 1.2fr 100px 100px 90px 110px", gap: 12, padding: "0 16px 8px" }} className="tablehead">
            <div>Ticker</div><div>Name</div><div style={{ textAlign: "right" }}>Value</div><div style={{ textAlign: "right" }}>Gain</div><div style={{ textAlign: "right" }}>Weight</div><div>30d</div>
          </div>
          {(holdings.data?.holdings ?? []).map((h) => (
            <div key={h.securityId} className="hoverable" style={{ display: "grid", gridTemplateColumns: "80px 1.2fr 100px 100px 90px 110px", gap: 12, padding: "8px 16px", alignItems: "center" }}>
              <span className="num" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--accent)" }}>{h.ticker ?? "—"}</span>
              <span style={{ fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{h.name ?? "—"}</span>
              <span className="num" style={{ fontSize: 12.5, fontWeight: 600, textAlign: "right" }}>{fmt(h.value)}</span>
              <span className="num" style={{ fontSize: 12.5, textAlign: "right", color: (h.gain ?? 0) >= 0 ? "var(--accent)" : "var(--danger)" }}>{h.gain !== null ? fmt(h.gain) : "—"}</span>
              <span className="num muted" style={{ fontSize: 12, textAlign: "right" }}>{fmtPct(h.weight, 1)}</span>
              <Spark values={h.spark30d.map((p) => p.value)} height={22} />
            </div>
          ))}
          {holdings.data?.holdings.length === 0 && <EmptyState text="No holdings yet — add positions above, then refresh prices." />}
        </Card>

        <Card>
          <div className="spread" style={{ marginBottom: 4 }}>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Buildings · rent P&L<Tip text="A manual asset with a valuation step-line (use 'revalue' when its value changes) plus monthly rental income minus buildings-covered expenses." /></div>
            {buildings.data?.asset && <span className="link" style={{ fontSize: 12 }} onClick={() => setRevalue(buildings.data!.asset)}>revalue</span>}
          </div>
          {buildings.data?.asset ? (
            <>
              <div className="muted" style={{ fontSize: 12 }}>
                latest valuation {fmt(buildings.data.asset.valuations[buildings.data.asset.valuations.length - 1]?.value)}
              </div>
              <Chart option={buildingsOption} height={190} />
            </>
          ) : (
            <EmptyState text="No manual asset named — add one from onboarding or via POST /api/assets." />
          )}
          <div className="col" style={{ gap: 6, marginTop: 8 }}>
            {(assets.data?.assets ?? []).map((a) => (
              <div key={a.asset_id} className="panel spread" style={{ padding: "8px 12px", fontSize: 12.5 }}>
                <span>{a.name} <span className="chip" style={{ marginLeft: 6 }}>{a.asset_class.replace(/_/g, " ")}</span></span>
                <span className="row" style={{ gap: 10 }}>
                  <b className="num">{fmt(a.valuations[a.valuations.length - 1]?.value)}</b>
                  <span className="link" style={{ fontSize: 11.5 }} onClick={() => setRevalue(a)}>revalue</span>
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {posDraft && (
        <Modal title={posDraft.positionId ? "Edit position" : "Add position"} onClose={() => setPosDraft(null)}>
          <div className="col" style={{ gap: 13 }}>
            <Field label="Account">
              <select className="input" value={posDraft.accountId} onChange={(e) => setPosDraft({ ...posDraft, accountId: e.target.value })}>
                {(positions.data?.accounts ?? []).map((a) => <option key={a.accountId} value={a.accountId}>{a.accountName ?? a.accountId}{a.registeredType ? ` (${a.registeredType})` : ""}</option>)}
              </select>
            </Field>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1.6fr", gap: 12 }}>
              <Field label="Symbol" hint={symbolCheck?.msg ?? "Yahoo symbol; TSX needs .TO"}>
                <input className="input num" value={posDraft.symbol} onChange={(e) => setPosDraft({ ...posDraft, symbol: e.target.value.toUpperCase() })} placeholder="XEQT.TO" style={{ borderColor: symbolCheck ? (symbolCheck.ok ? "var(--accent)" : "var(--warn)") : undefined }} />
              </Field>
              <Field label="Name"><input className="input" value={posDraft.name} onChange={(e) => setPosDraft({ ...posDraft, name: e.target.value })} placeholder="iShares All-Equity ETF" /></Field>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              <Field label="Type">
                <select className="input" value={posDraft.assetType} onChange={(e) => setPosDraft({ ...posDraft, assetType: e.target.value as PosDraft["assetType"] })}>
                  {ASSET_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </Field>
              <Field label="Quantity"><input className="input num" type="number" min={0} step="any" value={posDraft.quantity || ""} onChange={(e) => setPosDraft({ ...posDraft, quantity: Number(e.target.value) })} /></Field>
              <Field label="Book cost"><input className="input num" type="number" min={0} value={posDraft.bookCost ?? ""} onChange={(e) => setPosDraft({ ...posDraft, bookCost: e.target.value ? Number(e.target.value) : null })} /></Field>
            </div>
            {!posDraft.symbol && (
              <Field label="Manual value" hint="required when there's no market symbol (e.g. cash)">
                <input className="input num" type="number" min={0} value={posDraft.manualValue ?? ""} onChange={(e) => setPosDraft({ ...posDraft, manualValue: e.target.value ? Number(e.target.value) : null })} />
              </Field>
            )}
            <button className="btn" disabled={!posDraft.name || !posDraft.accountId || (!posDraft.symbol && posDraft.manualValue === null)}
              onClick={() => { savePos.mutate(posDraft); setPosDraft(null); }}>
              {posDraft.positionId ? "Save" : "Add position"}
            </button>
          </div>
        </Modal>
      )}

      {targetsOpen && (
        <TargetsModal slices={allocation.data?.allocation ?? []} onClose={() => setTargetsOpen(false)} onSave={(t) => { saveTargets.mutate(t); setTargetsOpen(false); }} />
      )}

      {revalue && (
        <Modal title={`Revalue ${revalue.name}`} onClose={() => setRevalue(null)}>
          <RevalueForm asset={revalue} onSubmit={(value) => { addValuation.mutate({ assetId: revalue.asset_id, value }); setRevalue(null); }} />
        </Modal>
      )}
    </div>
  );
}

function TargetsModal({ slices, onClose, onSave }: { slices: AllocationSlice[]; onClose: () => void; onSave: (t: Record<string, number>) => void }) {
  const [t, setT] = useState<Record<string, number>>(Object.fromEntries(slices.map((s) => [s.class, Math.round((s.target ?? s.weight) * 100)])));
  const total = Object.values(t).reduce((a, b) => a + b, 0);
  return (
    <Modal title="Allocation targets" onClose={onClose}>
      <div className="col" style={{ gap: 12 }}>
        {Object.entries(t).map(([cls, v]) => (
          <div key={cls} className="row" style={{ gap: 12 }}>
            <span style={{ flex: 1, fontSize: 13 }}>{cls}</span>
            <input className="input num" type="number" min={0} max={100} value={v} style={{ width: 90 }} onChange={(e) => setT({ ...t, [cls]: Number(e.target.value) })} />
            <span className="muted">%</span>
          </div>
        ))}
        <div className="muted" style={{ fontSize: 12, color: total === 100 ? "var(--accent)" : "var(--warn)" }}>total {total}%</div>
        <button className="btn" disabled={total !== 100} onClick={() => onSave(Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v / 100])))}>Save targets</button>
      </div>
    </Modal>
  );
}

function RevalueForm({ asset, onSubmit }: { asset: ManualAsset; onSubmit: (value: number) => void }) {
  const last = asset.valuations[asset.valuations.length - 1]?.value ?? 0;
  const [v, setV] = useState(last);
  return (
    <div className="col" style={{ gap: 13 }}>
      <Field label="New value" hint={`last valuation ${fmt(last)}`}>
        <input className="input num" type="number" min={0} value={v || ""} onChange={(e) => setV(Number(e.target.value))} />
      </Field>
      <button className="btn" disabled={!v} onClick={() => onSubmit(v)}>Record valuation</button>
    </div>
  );
}
