import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { useAction, useApi, useCtx } from "../api/hooks";
import { api } from "../api/client";
import type { AccountPositions, AllocationSlice, AssetType, BuildingsPnl, Holding, ManualAsset, OptionChain, Performance, PortfolioSeries, Position, PositionsView, Quote, SymbolHit } from "../api/types";
import { Card, EmptyState, Field, Modal, Seg, Spark, Spinner } from "../components/ui";
import { Tip } from "../components/Tip";
import { Chart, chartBase, EChartsOption } from "../components/Chart";
import { cssVar, fmt, fmtC, fmtPct, monthShort, palette } from "../lib/format";
import { useUi } from "../stores/ui";

const ASSET_TYPES: AssetType[] = ["stock", "etf", "crypto", "option", "currency", "commodity", "cash", "other"];
/** Types priced from a market symbol (vs. cash/other carried at manual value). */
const MARKET_TYPES = new Set<AssetType>(["stock", "etf", "crypto", "option", "currency", "commodity"]);
const LIVE_REFRESH_MS = 300_000; // 5 min — matches the backend intraday job cadence

interface OptionDraft { underlying: string; expiry: string; strike: number; optionType: "call" | "put"; currency?: string }
interface PosDraft {
  positionId?: string; accountId: string; symbol: string; name: string;
  assetType: AssetType; quantity: number; bookCost: number | null; manualValue: number | null;
  currency: string; option: OptionDraft | null;
}

/** Value settles into a debounced copy after `ms` of quiet. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function kindBadge(kind: string): string {
  return { stock: "EQ", etf: "ETF", crypto: "CRYPTO", option: "OPT", currency: "FX", commodity: "COMM", index: "IDX" }[kind] ?? kind.toUpperCase();
}

/** As-of freshness pill from an ISO timestamp. */
function AsOf({ iso }: { iso: string | null | undefined }) {
  if (!iso) return null;
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  const label = mins < 1 ? "live" : mins < 60 ? `${mins}m ago` : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return <span className="chip" style={{ fontSize: 11, color: "var(--ink-muted)" }} title={`quotes as of ${d.toLocaleString()}`}>● {label}</span>;
}

function ChangePct({ pct }: { pct: number | null | undefined }) {
  if (pct === null || pct === undefined) return null;
  const up = pct >= 0;
  return <span className="num" style={{ fontSize: 11, color: up ? "var(--accent)" : "var(--danger)" }}>{up ? "▲" : "▼"}{Math.abs(pct).toFixed(2)}%</span>;
}

export function Investments() {
  const { lens, month, q } = useCtx();
  const theme = useUi((s) => s.theme);
  const [decompose, setDecompose] = useState<"value" | "split">("value");
  const [editorOpen, setEditorOpen] = useState(false);
  const [posDraft, setPosDraft] = useState<PosDraft | null>(null);
  const [targetsOpen, setTargetsOpen] = useState(false);
  const [revalue, setRevalue] = useState<ManualAsset | null>(null);

  const live = { refetchInterval: LIVE_REFRESH_MS };
  const series = useApi<PortfolioSeries>(["portfolio.series", lens, decompose], `/api/portfolio/series${q}&days=365&decompose=${decompose === "split"}`, live);
  const holdings = useApi<{ holdings: Holding[] }>(["portfolio.holdings", lens], `/api/portfolio/holdings${q}`, live);
  const allocation = useApi<{ allocation: AllocationSlice[] }>(["portfolio.allocation", lens], `/api/portfolio/allocation${q}`, live);
  const performance = useApi<Performance>(["portfolio.performance", lens], `/api/portfolio/performance${q}&days=365`, live);
  const positions = useApi<PositionsView>(["positions", lens], `/api/positions${q}`, live);
  const assets = useApi<{ assets: ManualAsset[] }>(["portfolio.assets"], "/api/assets");
  const buildings = useApi<BuildingsPnl>(["portfolio.buildings", lens, month], `/api/portfolio/buildings${q}`);

  const savePos = useAction(
    (d: PosDraft) => {
      const body = {
        accountId: d.accountId, symbol: d.symbol || null, name: d.name, assetType: d.assetType,
        quantity: d.quantity, bookCost: d.bookCost, manualValue: d.manualValue, currency: d.currency || undefined,
        option: d.assetType === "option" && d.option ? d.option : undefined,
      };
      return d.positionId
        ? api(`/api/positions/${d.positionId}`, { method: "PATCH", json: body })
        : api("/api/positions", { method: "POST", json: body });
    },
    ["positions", "portfolio", "networth", "overview"],
  );
  const deletePos = useAction((id: string) => api(`/api/positions/${id}`, { method: "DELETE" }), ["positions", "portfolio", "networth"]);
  const refresh = useAction(() => api("/api/positions/refresh", { method: "POST", json: {} }), ["positions", "portfolio", "networth", "overview"]);
  const refreshLive = useAction(() => api("/api/positions/quotes/refresh", { method: "POST", json: {} }), ["positions", "portfolio", "overview"]);
  const saveTargets = useAction((t: Record<string, number>) => api("/api/portfolio/targets", { method: "PUT", json: t }), ["portfolio"]);
  const addValuation = useAction(
    (a: { assetId: string; value: number }) => api(`/api/assets/${a.assetId}/valuations`, { method: "POST", json: { date: new Date().toISOString().slice(0, 10), value: a.value, source: "manual revalue" } }),
    ["portfolio", "networth", "overview"],
  );

  // Opening the page pulls fresh live quotes for the whole portfolio once
  // (the manual buttons and the 5-min interval still apply).
  const didAutoRefresh = useRef(false);
  useEffect(() => {
    if (didAutoRefresh.current) return;
    didAutoRefresh.current = true;
    refreshLive.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  const openNew = () => setPosDraft({ accountId: positions.data?.accounts[0]?.accountId ?? "", symbol: "", name: "", assetType: "etf", quantity: 0, bookCost: null, manualValue: null, currency: "CAD", option: null });

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
            <div style={{ fontSize: 14, fontWeight: 600 }}>Positions <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>(you maintain these — Plaid investments needs production access)</span><Tip text="Enter what each investment account holds: search a ticker (stocks, ETFs, FX, commodities, options, crypto) or enter a manual value for cash. Prices refresh live every 5 min during market hours; 'Refresh prices' also rebuilds full history. The 'vs bank' chip flags drift between your entries and the reported balance." /></div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <AsOf iso={positions.data?.quotesAsOf} />
            <button className="btn-ghost" onClick={() => refreshLive.mutate()} disabled={refreshLive.isPending} title="Fetch live quotes now">
              {refreshLive.isPending ? <Spinner /> : "●"} Live
            </button>
            <button className="btn-ghost" onClick={() => refresh.mutate()} disabled={refresh.isPending} title="Pull daily closes and rebuild history">
              {refresh.isPending ? <Spinner /> : "↻"} Refresh prices
            </button>
            <button className="btn-ghost" onClick={() => setEditorOpen((s) => !s)}>{editorOpen ? "Done" : "Edit"}</button>
            <button className="btn" onClick={openNew}>+ Position</button>
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
              <div key={p.position_id} className="hoverable" style={{ display: "grid", gridTemplateColumns: "90px 1.4fr 90px 120px 120px 80px", gap: 12, padding: "7px 10px", alignItems: "center" }}>
                <span className="col" style={{ gap: 1 }}>
                  <span className="num" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--accent)" }}>{p.symbol ?? "—"}</span>
                  {p.currency && p.currency !== "CAD" && <span className="muted num" style={{ fontSize: 9.5 }}>{p.currency}</span>}
                </span>
                <span style={{ fontSize: 12.5 }}>{p.name}</span>
                <span className="num muted" style={{ fontSize: 12, textAlign: "right" }}>{p.quantity}</span>
                <span className="col" style={{ gap: 1, alignItems: "flex-end" }}>
                  <span className="num muted" style={{ fontSize: 12 }}>{p.lastPrice !== null ? fmtC(p.lastPrice) : "manual"}</span>
                  <ChangePct pct={p.changePct} />
                </span>
                <span className="num" style={{ fontSize: 12.5, fontWeight: 600, textAlign: "right" }}>{fmt(p.currentValue)}</span>
                {editorOpen ? (
                  <span className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
                    <span className="link" style={{ fontSize: 11.5 }} onClick={() => setPosDraft({ positionId: p.position_id, accountId: p.account_id, symbol: p.symbol ?? "", name: p.name, assetType: p.asset_type, quantity: p.quantity, bookCost: p.book_cost, manualValue: p.manual_value, currency: p.currency, option: null })}>edit</span>
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
              <span className="col" style={{ gap: 1, minWidth: 0 }}>
                <span style={{ fontSize: 12.5, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{h.name ?? "—"}</span>
                <ChangePct pct={h.changePct} />
              </span>
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
        <PositionModal
          draft={posDraft}
          setDraft={setPosDraft}
          accounts={positions.data?.accounts ?? []}
          onSave={() => { savePos.mutateAsync(posDraft).then(() => refreshLive.mutate()).catch(() => {}); setPosDraft(null); }}
        />
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

// ---- Add / edit position modal ----

function PositionModal({ draft, setDraft, accounts, onSave }: { draft: PosDraft; setDraft: Dispatch<SetStateAction<PosDraft | null>>; accounts: AccountPositions[]; onSave: () => void }) {
  const isOption = draft.assetType === "option";
  const isManual = !MARKET_TYPES.has(draft.assetType);
  const canSave = !!draft.name && !!draft.accountId && (isManual ? draft.manualValue !== null : !!draft.symbol) && draft.quantity >= 0;
  const foreign = !!draft.currency && draft.currency !== "CAD";
  const currencyOptions = Array.from(new Set(["CAD", "USD", draft.currency].filter(Boolean)));

  // Live quote preview for the chosen symbol; also auto-detects the currency
  // the instrument trades in (so picking a US stock sets USD).
  const [quote, setQuote] = useState<Quote | null>(null);
  useEffect(() => {
    if (!draft.symbol || isManual) { setQuote(null); return; }
    let alive = true;
    const symbol = draft.symbol;
    api<{ quotes: Quote[] }>(`/api/securities/quote?symbols=${encodeURIComponent(symbol)}`)
      .then((r) => {
        if (!alive) return;
        const qt = r.quotes[0] ?? null;
        setQuote(qt);
        if (qt?.currency) setDraft((d) => (d && d.symbol === symbol && d.currency !== qt.currency ? { ...d, currency: qt.currency } : d));
      })
      .catch(() => { if (alive) setQuote(null); });
    return () => { alive = false; };
  }, [draft.symbol, isManual, setDraft]);

  return (
    <Modal title={draft.positionId ? "Edit position" : "Add position"} onClose={() => setDraft(null)} width={560}>
      <div className="col" style={{ gap: 13 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 12 }}>
          <Field label="Account">
            <select className="input" value={draft.accountId} onChange={(e) => setDraft({ ...draft, accountId: e.target.value })}>
              {accounts.map((a) => <option key={a.accountId} value={a.accountId}>{a.accountName ?? a.accountId}{a.registeredType ? ` (${a.registeredType})` : ""}</option>)}
            </select>
          </Field>
          <Field label="Type">
            <select className="input" value={draft.assetType} onChange={(e) => {
              const assetType = e.target.value as AssetType;
              // Switching into/out of market vs manual clears stale symbol/option state.
              setDraft({ ...draft, assetType, symbol: MARKET_TYPES.has(assetType) ? draft.symbol : "", option: null });
            }}>
              {ASSET_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </Field>
        </div>

        {isOption ? (
          <OptionPicker
            onPick={(c) => setDraft({ ...draft, symbol: c.contractSymbol, name: c.name, currency: c.currency, option: { underlying: c.underlying, expiry: c.expiry, strike: c.strike, optionType: c.optionType, currency: c.currency } })}
            picked={draft.symbol}
          />
        ) : !isManual ? (
          <Field label="Symbol" hint={quote ? `${fmtC(quote.price)} ${quote.currency}${quote.changePct !== null ? ` · ${quote.changePct >= 0 ? "+" : ""}${quote.changePct.toFixed(2)}%` : ""}` : "Search a ticker, or type an exact symbol (TSX needs .TO)"}>
            <SymbolSearch
              initial={draft.symbol}
              onPick={(hit) => setDraft({ ...draft, symbol: hit.symbol, name: hit.name || draft.name || hit.symbol, currency: hit.currency ?? draft.currency, assetType: mapKind(hit.kind, draft.assetType) })}
              onRaw={(sym) => setDraft({ ...draft, symbol: sym, name: draft.name || sym })}
            />
          </Field>
        ) : null}

        <Field label="Name"><input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="iShares All-Equity ETF" /></Field>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          <Field label={isOption ? "Contracts" : "Quantity"}><input className="input num" type="number" min={0} step="any" value={draft.quantity || ""} onChange={(e) => setDraft({ ...draft, quantity: Number(e.target.value) })} /></Field>
          <Field label={`Book cost${foreign ? ` (${draft.currency})` : ""}`} hint={`total you paid, in ${draft.currency || "CAD"}`}>
            <input className="input num" type="number" min={0} value={draft.bookCost ?? ""} onChange={(e) => setDraft({ ...draft, bookCost: e.target.value ? Number(e.target.value) : null })} />
          </Field>
          <Field label="Currency" hint={foreign ? "→ CAD at market rate" : undefined}>
            <select className="input" value={draft.currency} onChange={(e) => setDraft({ ...draft, currency: e.target.value })}>
              {currencyOptions.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </Field>
        </div>

        {foreign && (
          <div className="muted" style={{ fontSize: 11.5, marginTop: -4 }}>
            Prices and book cost are in {draft.currency}; the portfolio converts them to CAD at the current market rate.
          </div>
        )}

        {isManual && (
          <Field label={`Manual value${foreign ? ` (${draft.currency})` : ""}`} hint="required for cash / other (no market symbol)">
            <input className="input num" type="number" min={0} value={draft.manualValue ?? ""} onChange={(e) => setDraft({ ...draft, manualValue: e.target.value ? Number(e.target.value) : null })} />
          </Field>
        )}

        <button className="btn" disabled={!canSave} onClick={onSave}>{draft.positionId ? "Save" : "Add position"}</button>
      </div>
    </Modal>
  );
}

/** Best-effort: adopt the searched instrument's kind as the position type. */
function mapKind(kind: SymbolHit["kind"], fallback: AssetType): AssetType {
  const map: Record<string, AssetType> = { stock: "stock", etf: "etf", crypto: "crypto", currency: "currency", commodity: "commodity", option: "option" };
  return map[kind] ?? fallback;
}

// ---- Symbol autocomplete ----

function SymbolSearch({ initial, onPick, onRaw }: { initial: string; onPick: (hit: SymbolHit) => void; onRaw: (sym: string) => void }) {
  const [text, setText] = useState(initial);
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const debounced = useDebounced(text.trim(), 250);
  const search = useApi<{ hits: SymbolHit[] }>(["securities.search", debounced], debounced.length >= 1 && open ? `/api/securities/search?q=${encodeURIComponent(debounced)}` : null, { retry: false });
  const hits = search.data?.hits ?? [];

  useEffect(() => {
    const onDoc = (e: MouseEvent) => { if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const choose = (h: SymbolHit) => { setText(h.symbol); onPick(h); setOpen(false); };
  const commitRaw = () => { const s = text.trim().toUpperCase(); if (s) { onRaw(s); setOpen(false); } };

  return (
    <div ref={boxRef} style={{ position: "relative" }}>
      <input
        className="input num" value={text} placeholder="AAPL · XEQT.TO · BTC-CAD · EURUSD=X"
        onChange={(e) => { setText(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); if (hits[0]) choose(hits[0]); else commitRaw(); } }}
      />
      {open && debounced.length >= 1 && (
        <div className="panel" style={{ position: "absolute", top: "100%", left: 0, right: 0, marginTop: 4, zIndex: 20, maxHeight: 260, overflowY: "auto", padding: 4 }}>
          {search.isFetching && hits.length === 0 && <div className="muted" style={{ padding: "8px 10px", fontSize: 12 }}><Spinner /> searching…</div>}
          {!search.isFetching && hits.length === 0 && <div className="muted" style={{ padding: "8px 10px", fontSize: 12 }}>no matches — press Enter to use “{text.toUpperCase()}”</div>}
          {hits.map((h) => (
            <div key={h.symbol} className="hoverable row" style={{ gap: 8, padding: "7px 10px", cursor: "pointer", alignItems: "center" }} onClick={() => choose(h)}>
              <span className="num" style={{ fontSize: 12.5, fontWeight: 700, color: "var(--accent)", minWidth: 78 }}>{h.symbol}</span>
              <span style={{ fontSize: 12, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{h.name}</span>
              <span className="chip" style={{ fontSize: 10 }}>{kindBadge(h.kind)}</span>
              {h.exchange && <span className="muted" style={{ fontSize: 10.5 }}>{h.exchange}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Option chain picker ----

interface PickedContract { contractSymbol: string; name: string; underlying: string; expiry: string; strike: number; optionType: "call" | "put"; currency: string }

function OptionPicker({ onPick, picked }: { onPick: (c: PickedContract) => void; picked: string }) {
  const [underlying, setUnderlying] = useState("");
  const [loaded, setLoaded] = useState("");
  const [expiry, setExpiry] = useState<string>("");
  const [side, setSide] = useState<"call" | "put">("call");
  const chain = useApi<OptionChain>(["options.chain", loaded, expiry], loaded ? `/api/options/chain?underlying=${encodeURIComponent(loaded)}${expiry ? `&expiry=${expiry}` : ""}` : null, { retry: false });

  useEffect(() => { if (chain.data && !expiry && chain.data.expiry) setExpiry(chain.data.expiry); }, [chain.data]);

  const rows = (side === "call" ? chain.data?.calls : chain.data?.puts) ?? [];

  return (
    <div className="col" style={{ gap: 10 }}>
      <div className="row" style={{ gap: 8, alignItems: "flex-end" }}>
        <Field label="Underlying">
          <input className="input num" value={underlying} placeholder="AAPL" onChange={(e) => setUnderlying(e.target.value.toUpperCase())} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); setExpiry(""); setLoaded(underlying.trim()); } }} />
        </Field>
        <button className="btn-ghost" onClick={() => { setExpiry(""); setLoaded(underlying.trim()); }} disabled={!underlying.trim()}>Load chain</button>
      </div>

      {chain.isFetching && <div className="muted" style={{ fontSize: 12 }}><Spinner /> loading chain…</div>}
      {chain.isError && <div style={{ fontSize: 12, color: "var(--warn)" }}>No chain for “{loaded}”. Options need US-style underlyings (e.g. AAPL).</div>}

      {chain.data && (
        <>
          <div className="row" style={{ gap: 8 }}>
            <select className="input" style={{ maxWidth: 180 }} value={expiry} onChange={(e) => setExpiry(e.target.value)}>
              {chain.data.expiries.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
            <Seg subtle value={side} onChange={setSide} items={[{ key: "call" as const, label: "Calls" }, { key: "put" as const, label: "Puts" }]} />
          </div>
          <div className="panel" style={{ maxHeight: 220, overflowY: "auto", padding: 4 }}>
            <div className="tablehead" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, padding: "2px 8px" }}>
              <div>Strike</div><div style={{ textAlign: "right" }}>Bid</div><div style={{ textAlign: "right" }}>Ask</div><div style={{ textAlign: "right" }}>Last</div>
            </div>
            {rows.map((o) => {
              const active = o.contractSymbol === picked;
              return (
                <div key={o.contractSymbol} className="hoverable" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8, padding: "6px 8px", cursor: "pointer", fontSize: 12, background: active ? "color-mix(in srgb, var(--accent) 14%, transparent)" : undefined }}
                  onClick={() => onPick({ contractSymbol: o.contractSymbol, name: `${chain.data!.underlying} ${expiry} ${side === "call" ? "C" : "P"} ${o.strike}`, underlying: chain.data!.underlying, expiry, strike: o.strike, optionType: side, currency: o.currency })}>
                  <span className="num" style={{ fontWeight: 700 }}>{o.strike}</span>
                  <span className="num muted" style={{ textAlign: "right" }}>{o.bid !== null ? fmtC(o.bid) : "—"}</span>
                  <span className="num muted" style={{ textAlign: "right" }}>{o.ask !== null ? fmtC(o.ask) : "—"}</span>
                  <span className="num" style={{ textAlign: "right" }}>{o.lastPrice !== null ? fmtC(o.lastPrice) : "—"}</span>
                </div>
              );
            })}
            {rows.length === 0 && !chain.isFetching && <div className="muted" style={{ padding: 8, fontSize: 12 }}>no contracts for this expiry</div>}
          </div>
          {picked && <div className="muted" style={{ fontSize: 11.5 }}>selected: <span className="num">{picked}</span></div>}
        </>
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
