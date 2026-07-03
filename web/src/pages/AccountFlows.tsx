import { useEffect, useMemo, useRef, useState } from "react";
import { useApi, useCtx, usePersons } from "../api/hooks";
import { api } from "../api/client";
import type { AccountFlow, AccountFlowsView, FlowLayout } from "../api/types";
import { Card, EmptyState } from "../components/ui";
import { Tip } from "../components/Tip";
import { dayLabel, fmt, monthLabel } from "../lib/format";

/**
 * Account Flows — how money moved between our own accounts this month.
 * Cards are draggable; positions persist server-side (settings row) so the
 * layout you arrange is the layout you get next visit. Band width = amount,
 * amber = debt payment (credit cards linked to debts), teal = into savings
 * or registered accounts, slate = everything else.
 */

const CARD_W = 220;
const GAP = 3;
const LANE_X = [10, 380, 750];
const TOP = 34;
const ROW_H = 96;

const BAND_COLOR: Record<AccountFlow["kind"], string> = {
  move: "rgba(148,163,184,.30)",
  save: "rgba(63,195,173,.36)",
  debt: "rgba(230,184,76,.34)",
};
const KIND_LABEL: Record<AccountFlow["kind"], string> = {
  move: "transfer",
  save: "savings & goals",
  debt: "debt payment",
};

type Hover = { kind: "flow"; flow: AccountFlow } | { kind: "acct"; id: string } | null;

export function AccountFlows() {
  const { lens, month, q } = useCtx();
  const persons = usePersons();
  const view = useApi<AccountFlowsView>(["cashflow.transfers", lens, month], `/api/cashflow/transfers${q}`);
  const savedLayout = useApi<{ layout: FlowLayout }>(["cashflow.transfers.layout"], "/api/cashflow/transfers/layout");

  const [pos, setPos] = useState<FlowLayout>({});
  const [hover, setHover] = useState<Hover>(null);
  const dragging = useRef<string | null>(null);

  const data = view.data;
  const flows = data?.flows ?? [];
  const accounts = data?.accounts ?? [];
  const personName = (id: string | null) =>
    id === null ? "joint" : (persons.data?.persons.find((p) => p.person_id === id)?.display_name ?? id);

  const bandW = useMemo(() => {
    const max = Math.max(1, ...flows.map((f) => f.total));
    return (f: AccountFlow) => Math.max(3, (f.total / max) * 42);
  }, [flows]);

  const stackH = (fs: AccountFlow[]) =>
    fs.reduce((s, f) => s + bandW(f), 0) + GAP * Math.max(0, fs.length - 1);
  const cardH = (accountId: string) => {
    const outs = flows.filter((f) => f.fromAccountId === accountId);
    const ins = flows.filter((f) => f.toAccountId === accountId);
    return Math.max(56, Math.max(stackH(outs), stackH(ins)) + 26);
  };

  // saved positions win; new accounts get a default lane by flow direction
  useEffect(() => {
    if (!data || !savedLayout.data) return;
    const saved = savedLayout.data.layout;
    const laneOf = (id: string) => {
      const sends = flows.some((f) => f.fromAccountId === id);
      const receives = flows.some((f) => f.toAccountId === id);
      return sends && receives ? 1 : sends ? 0 : 2;
    };
    const laneCount = [0, 0, 0];
    const next: FlowLayout = {};
    for (const a of accounts) {
      if (saved[a.accountId]) {
        next[a.accountId] = saved[a.accountId];
      } else {
        const lane = laneOf(a.accountId);
        next[a.accountId] = { x: LANE_X[lane], y: TOP + laneCount[lane] * ROW_H + (lane === 1 ? 40 : 0) };
        laneCount[lane]++;
      }
    }
    setPos(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, savedLayout.data]);

  const persist = (layout: FlowLayout) =>
    api("/api/cashflow/transfers/layout", { method: "PUT", json: { layout } }).catch(() => undefined);

  const onDrag = (accountId: string, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging.current = accountId;
    const origin = { px: e.clientX, py: e.clientY, x: pos[accountId]?.x ?? 0, y: pos[accountId]?.y ?? 0 };
    const onMove = (ev: PointerEvent) => {
      setPos((p) => ({
        ...p,
        [accountId]: {
          x: Math.max(0, Math.round(origin.x + ev.clientX - origin.px)),
          y: Math.max(0, Math.round(origin.y + ev.clientY - origin.py)),
        },
      }));
    };
    const onUp = () => {
      dragging.current = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      setPos((p) => {
        persist(p);
        return p;
      });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // geometry is fully derived from state — no DOM measuring needed
  const bands = useMemo(() => {
    const rect = (id: string) => {
      const p = pos[id] ?? { x: 0, y: 0 };
      const h = cardH(id);
      return { left: p.x, right: p.x + CARD_W, cy: p.y + h / 2 };
    };
    const yOut = new Map<AccountFlow, number>();
    const yIn = new Map<AccountFlow, number>();
    for (const a of accounts) {
      const outs = flows.filter((f) => f.fromAccountId === a.accountId).sort((x, y) => rect(x.toAccountId).cy - rect(y.toAccountId).cy);
      const ins = flows.filter((f) => f.toAccountId === a.accountId).sort((x, y) => rect(x.fromAccountId).cy - rect(y.fromAccountId).cy);
      let oy = rect(a.accountId).cy - stackH(outs) / 2;
      for (const f of outs) { yOut.set(f, oy + bandW(f) / 2); oy += bandW(f) + GAP; }
      let iy = rect(a.accountId).cy - stackH(ins) / 2;
      for (const f of ins) { yIn.set(f, iy + bandW(f) / 2); iy += bandW(f) + GAP; }
    }
    return flows.map((f) => {
      const from = rect(f.fromAccountId);
      const to = rect(f.toAccountId);
      const forward = to.left >= from.right - 1;
      const x1 = forward ? from.right : from.left;
      const x2 = forward ? to.left : to.right;
      const y1 = yOut.get(f) ?? from.cy;
      const y2 = yIn.get(f) ?? to.cy;
      const mx = (x1 + x2) / 2;
      return { flow: f, w: bandW(f), d: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}` };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flows, accounts, pos]);

  const canvasH = Math.max(
    380,
    ...accounts.map((a) => (pos[a.accountId]?.y ?? 0) + cardH(a.accountId) + 28),
  );

  const accName = (id: string) => accounts.find((a) => a.accountId === id)?.name ?? id;
  const flowDimmed = (f: AccountFlow) => {
    if (!hover) return false;
    if (hover.kind === "flow") return hover.flow !== f;
    return f.fromAccountId !== hover.id && f.toAccountId !== hover.id;
  };
  const acctDimmed = (id: string) => {
    if (!hover) return false;
    if (hover.kind === "flow") return id !== hover.flow.fromAccountId && id !== hover.flow.toAccountId;
    if (id === hover.id) return false;
    return !flows.some((f) => (f.fromAccountId === hover.id && f.toAccountId === id) || (f.toAccountId === hover.id && f.fromAccountId === id));
  };

  return (
    <div className="page col" style={{ gap: 20 }}>
      <Card style={{ padding: "20px 24px" }}>
        <div className="spread" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: 14 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Money movement between accounts<Tip text="Transfers between your own accounts for the month — excluded from spending, shown here instead. Band width = amount. Drag accounts to arrange the map; the layout is remembered. Credit-card payments (amber) reduce the linked debt's balance; the card's purchases are budgeted separately." /></div>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>{monthLabel(month)} · drag accounts to rearrange — the layout is saved · hover for detail</div>
          </div>
          <div className="row" style={{ gap: 28 }}>
            {[
              { k: "Total moved", v: fmt(data?.totalMoved), c: "var(--ink)" },
              { k: "To savings & goals", v: fmt(data?.toSavings), c: "var(--accent)" },
              { k: "Debt payments", v: fmt(data?.debtPayments), c: "var(--warn)" },
              { k: "Transfers", v: String(data?.transferCount ?? "—"), c: "var(--ink)" },
            ].map((s) => (
              <div key={s.k}>
                <div className="label">{s.k}</div>
                <div className="num" style={{ fontSize: 18, fontWeight: 600, marginTop: 2, color: s.c }}>{s.v}</div>
              </div>
            ))}
          </div>
        </div>
      </Card>

      <Card style={{ padding: 0, overflow: "hidden" }}>
        {flows.length === 0 && (
          <EmptyState text="No transfers between accounts this month — moves are detected automatically when both sides appear within 8 days." />
        )}
        {flows.length > 0 && (
          <>
            <div style={{ position: "relative", height: canvasH, margin: "10px 14px 0" }}>
              <svg style={{ position: "absolute", inset: 0, overflow: "visible", zIndex: 0 }} width="100%" height={canvasH}>
                {bands.map((b, i) => (
                  <path key={i} d={b.d} fill="none" stroke={BAND_COLOR[b.flow.kind]} strokeWidth={b.w}
                    style={{ opacity: flowDimmed(b.flow) ? 0.14 : 1, transition: "opacity .18s", cursor: "pointer" }}
                    onMouseEnter={() => setHover({ kind: "flow", flow: b.flow })}
                    onMouseLeave={() => setHover(null)} />
                ))}
              </svg>
              {accounts.map((a) => {
                const p = pos[a.accountId] ?? { x: 0, y: 0 };
                const inn = flows.filter((f) => f.toAccountId === a.accountId).reduce((s, f) => s + f.total, 0);
                const out = flows.filter((f) => f.fromAccountId === a.accountId).reduce((s, f) => s + f.total, 0);
                return (
                  <div key={a.accountId}
                    onPointerDown={(e) => onDrag(a.accountId, e)}
                    onMouseEnter={() => setHover({ kind: "acct", id: a.accountId })}
                    onMouseLeave={() => setHover(null)}
                    style={{
                      position: "absolute", left: p.x, top: p.y, width: CARD_W, height: cardH(a.accountId), zIndex: 1,
                      background: "var(--surface-2)", border: "1px solid var(--line)", borderRadius: 10,
                      padding: "8px 12px", cursor: "grab", userSelect: "none", touchAction: "none",
                      display: "flex", flexDirection: "column", justifyContent: "center",
                      opacity: acctDimmed(a.accountId) ? 0.3 : 1, transition: dragging.current ? "none" : "opacity .18s",
                    }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                      {a.name} <span className="muted num" style={{ fontWeight: 400, fontSize: 11 }}>····{a.mask ?? "?"}</span>
                    </div>
                    <div className="muted num" style={{ fontSize: 11, display: "flex", justifyContent: "space-between", marginTop: 2 }}>
                      <span>{personName(a.personId)}{inn > 0 ? ` · in ${fmt(inn)}` : ""}</span>
                      <span>{out > 0 ? `out ${fmt(out)}` : ""}</span>
                    </div>
                    {a.debtLinked && <div style={{ fontSize: 10, color: "var(--warn)", marginTop: 2 }}>linked to debt — balance syncs nightly</div>}
                  </div>
                );
              })}
            </div>

            <div style={{ borderTop: "1px solid var(--line)", padding: "12px 20px", minHeight: 54, fontSize: 12.5 }}>
              {!hover && <span className="muted">Hover a flow or an account for its transfers · drag accounts to rearrange.</span>}
              {hover?.kind === "flow" && (
                <div className="row" style={{ gap: 20, flexWrap: "wrap" }}>
                  <b>{accName(hover.flow.fromAccountId)} → {accName(hover.flow.toAccountId)} · <span className="num" style={{ color: "var(--accent)" }}>{fmt(hover.flow.total)}</span></b>
                  {hover.flow.items.map((it, i) => (
                    <span key={i} className="muted">{dayLabel(it.date)} <b className="num" style={{ color: "var(--ink)" }}>{fmt(it.amount)}</b></span>
                  ))}
                </div>
              )}
              {hover?.kind === "acct" && (() => {
                const fs = flows.filter((f) => f.fromAccountId === hover.id || f.toAccountId === hover.id);
                const inn = fs.filter((f) => f.toAccountId === hover.id).reduce((s, f) => s + f.total, 0);
                const out = fs.filter((f) => f.fromAccountId === hover.id).reduce((s, f) => s + f.total, 0);
                return (
                  <div className="row" style={{ gap: 20, flexWrap: "wrap" }}>
                    <b>{accName(hover.id)} · <span className="num">in {fmt(inn)}</span> · <span className="num">out {fmt(out)}</span></b>
                    {fs.map((f, i) => (
                      <span key={i} className="muted">
                        {f.fromAccountId === hover.id ? `→ ${accName(f.toAccountId)}` : `← ${accName(f.fromAccountId)}`}{" "}
                        <b className="num" style={{ color: "var(--ink)" }}>{fmt(f.total)}</b>
                      </span>
                    ))}
                  </div>
                );
              })()}
            </div>
          </>
        )}
      </Card>

      {flows.length > 0 && (
        <Card style={{ padding: 8 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 140px 90px 110px", gap: 12, padding: "10px 16px 8px" }} className="tablehead">
            <div>From</div><div>To</div><div>Type</div><div style={{ textAlign: "right" }}>Transfers</div><div style={{ textAlign: "right" }}>Amount</div>
          </div>
          {flows.map((f, i) => (
            <div key={i} className="hoverable" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 140px 90px 110px", gap: 12, padding: "10px 16px", alignItems: "center", fontSize: 12.5 }}
              onMouseEnter={() => setHover({ kind: "flow", flow: f })} onMouseLeave={() => setHover(null)}>
              <div style={{ fontWeight: 600 }}>{accName(f.fromAccountId)}</div>
              <div>{accName(f.toAccountId)}</div>
              <div><span className="chip" style={f.kind === "debt" ? { color: "var(--warn)" } : f.kind === "save" ? { color: "var(--accent)" } : undefined}>{KIND_LABEL[f.kind]}</span></div>
              <div className="num" style={{ textAlign: "right" }}>{f.count}</div>
              <div className="num" style={{ textAlign: "right", fontWeight: 600 }}>{fmt(f.total)}</div>
            </div>
          ))}
          <div className="muted" style={{ fontSize: 11, padding: "10px 16px", lineHeight: 1.5 }}>
            Credit-card payments are transfers to the card's account; the card is linked to a debt, so the payment reduces the tracked balance — it is not counted as spending. The purchases themselves are budgeted when they occur.
          </div>
        </Card>
      )}
    </div>
  );
}
