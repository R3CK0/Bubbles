import { useEffect, useMemo, useState } from "react";
import { useAction, useApi, useCtx } from "../api/hooks";
import { api, qs } from "../api/client";
import type { Category, TransactionListItem, TransactionsListView, TransferMarkResult } from "../api/types";
import { Card, EmptyState } from "../components/ui";
import { Tip } from "../components/Tip";
import { dayLabel, fmt, fmtC, monthLabel } from "../lib/format";

const PAGE = 100;

/** Every transaction of the viewed month — searchable, filterable, and each
 *  row opens a drawer where the category can be changed. */
export function Transactions() {
  const { lens, month } = useCtx();
  const [search, setSearch] = useState("");
  const [needle, setNeedle] = useState("");
  const [category, setCategory] = useState("");
  const [sortKey, setSortKey] = useState("date-desc");
  const [limit, setLimit] = useState(PAGE);
  const [selected, setSelected] = useState<TransactionListItem | null>(null);

  // debounce the search box so typing doesn't refetch per keystroke
  useEffect(() => {
    const t = setTimeout(() => setNeedle(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);
  useEffect(() => setLimit(PAGE), [lens, month, needle, category, sortKey]);

  const [sort, dir] = sortKey.split("-");
  const q = qs({ lens, month, search: needle, category, sort, dir, limit });
  const view = useApi<TransactionsListView>(["categories.transactions", lens, month, needle, category, sortKey, limit], `/api/transactions/all${q}`);
  const categories = useApi<{ categories: Category[] }>(["categories"], "/api/categories");
  const cats = categories.data?.categories ?? [];
  const catById = useMemo(() => new Map(cats.map((c) => [c.category_id, c])), [cats]);
  const catLabel = (id: string | null) => {
    if (!id) return null;
    const c = catById.get(id);
    if (!c) return id;
    const parent = c.parent_id ? catById.get(c.parent_id) : null;
    return parent ? `${parent.name} → ${c.name}` : c.name;
  };

  const categorize = useAction(
    (args: { transactionId: string; categoryId: string | null }) =>
      api(`/api/transactions/${args.transactionId}/categorize`, { method: "POST", json: { categoryId: args.categoryId } }),
    ["categories", "cashflow", "budget", "overview"],
  );
  const markTransfer = useAction(
    (transactionId: string) =>
      api<TransferMarkResult>(`/api/transactions/${transactionId}/transfer`, { method: "POST" }),
    ["categories", "cashflow", "budget", "overview", "alerts"],
  );
  const unmarkTransfer = useAction(
    (transactionId: string) => api(`/api/transactions/${transactionId}/transfer`, { method: "DELETE" }),
    ["categories", "cashflow", "budget", "overview"],
  );

  const tops = cats.filter((c) => c.parent_id === null && !c.archived);
  const rowChips = (t: TransactionListItem) => (
    <>
      {t.pending && <span className="chip">pending</span>}
      {t.isTransfer && (
        t.transferPending
          ? <span className="chip" style={{ background: "color-mix(in srgb, var(--warn) 14%, transparent)", color: "var(--warn)" }} title="marked as a transfer — waiting for the matching leg in another account">⇄ transfer · pending</span>
          : <span className="chip" title="paired with its matching leg in another account">⇄ transferred</span>
      )}
      {t.reimbursedBy === "work" && <span className="chip">💼 work</span>}
      {t.reimbursedBy === "buildings" && <span className="chip">🏢 buildings</span>}
      {t.goalId && <span className="chip chip-accent">🎯 goal</span>}
    </>
  );

  const v = view.data;
  return (
    <div className="page col" style={{ gap: 16 }}>
      <div className="spread">
        <div>
          <div className="h1">Transactions · {monthLabel(month)}</div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>
            The month's raw ledger — every synced transaction, transfers and flagged rows included. Click a row to inspect it or change its category.
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16 }}>
        {[
          { label: "Transactions", val: v ? String(v.count) : "—", color: "var(--ink)" },
          { label: "Money in", val: fmt(v?.totalIn), color: "var(--accent)", tip: "Deposits in the current filter, transfers excluded." },
          { label: "Money out", val: fmt(v?.totalOut), color: "var(--ink)", tip: "Spending in the current filter, transfers excluded." },
        ].map((k) => (
          <Card key={k.label} style={{ padding: "16px 18px" }}>
            <div className="label">{k.label}{"tip" in k && k.tip ? <Tip below text={k.tip as string} /> : null}</div>
            <div className="num" style={{ fontSize: 24, fontWeight: 600, marginTop: 5, color: k.color }}>{k.val}</div>
          </Card>
        ))}
      </div>

      <Card style={{ padding: 8 }}>
        <div className="row" style={{ gap: 10, padding: "10px 16px" }}>
          <input className="input" placeholder="Search merchant…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, maxWidth: 320 }} />
          <select className="input" style={{ width: "auto" }} value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">All categories</option>
            <option value="uncategorized">Uncategorized</option>
            <option value="transfer">Transfers</option>
            {tops.map((c) => (
              <optgroup key={c.category_id} label={c.name}>
                <option value={c.category_id}>{c.name}</option>
                {cats.filter((x) => x.parent_id === c.category_id && !x.archived).map((x) => (
                  <option key={x.category_id} value={x.category_id}>{c.name} → {x.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <select className="input" style={{ width: "auto" }} value={sortKey} onChange={(e) => setSortKey(e.target.value)} title="Sort transactions">
            <option value="date-desc">Newest first</option>
            <option value="date-asc">Oldest first</option>
            <option value="account-asc">Account (A→Z)</option>
            <option value="category-asc">Category (A→Z)</option>
            <option value="amount-desc">Amount (high→low)</option>
            <option value="amount-asc">Amount (low→high)</option>
          </select>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "86px 1.5fr 1fr 1fr 110px", gap: 12, padding: "4px 16px 8px" }} className="tablehead">
          <div>Date</div><div>Merchant</div><div>Account</div><div>Category</div><div style={{ textAlign: "right" }}>Amount</div>
        </div>
        {(v?.transactions ?? []).map((t) => (
          <div key={t.transactionId} className="hoverable" style={{ display: "grid", gridTemplateColumns: "86px 1.5fr 1fr 1fr 110px", gap: 12, padding: "10px 16px", alignItems: "center", cursor: "pointer" }}
            onClick={() => setSelected(t)}>
            <div className="muted num" style={{ fontSize: 12 }}>{dayLabel(t.date)}</div>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.merchant ?? "—"}</div>
              <div className="row" style={{ gap: 4, marginTop: 2 }}>{rowChips(t)}</div>
            </div>
            <div className="muted" style={{ fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {t.accountName}{t.accountMask && <span className="num" style={{ marginLeft: 4, fontSize: 11 }}>····{t.accountMask}</span>}
            </div>
            <div style={{ fontSize: 12 }}>
              {t.isTransfer
                ? <span className="muted">—</span>
                : t.categoryId
                  ? <span className="chip chip-accent" style={{ fontSize: 11.5 }}>{catLabel(t.categoryId)}</span>
                  : <span className="chip" style={{ fontSize: 11.5, background: "color-mix(in srgb, var(--warn) 14%, transparent)", color: "var(--warn)" }}>uncategorized</span>}
            </div>
            <div className="num" style={{ fontSize: 13, fontWeight: 600, textAlign: "right", color: t.amount > 0 ? "var(--accent)" : "var(--ink)" }}>
              {t.amount > 0 ? "+" : ""}{fmtC(t.amount)}
            </div>
          </div>
        ))}
        {v && v.transactions.length === 0 && <EmptyState text="No transactions match — try another month, search, or category." />}
        {!v && <div className="empty">Loading…</div>}
        {v && v.count > v.transactions.length && (
          <div style={{ padding: "10px 16px" }}>
            <button className="btn-ghost" style={{ width: "100%", justifyContent: "center" }} onClick={() => setLimit((l) => l + PAGE)}>
              Show more ({v.transactions.length} of {v.count})
            </button>
          </div>
        )}
      </Card>

      {selected && (
        <div className="drawer" onClick={(e) => e.stopPropagation()}>
          <div className="spread" style={{ padding: "18px 20px", borderBottom: "1px solid var(--line)" }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{selected.merchant ?? "Unknown merchant"}</div>
              <div className="muted" style={{ fontSize: 12 }}>{dayLabel(selected.date)} · {selected.accountName}{selected.accountMask ? ` ····${selected.accountMask}` : ""}</div>
            </div>
            <div style={{ cursor: "pointer", fontSize: 20, color: "var(--ink-muted)" }} onClick={() => setSelected(null)}>×</div>
          </div>
          <div style={{ padding: 20 }} className="col">
            <div className="num" style={{ fontSize: 28, fontWeight: 600, color: selected.amount > 0 ? "var(--accent)" : "var(--ink)" }}>
              {selected.amount > 0 ? "+" : ""}{fmtC(selected.amount)}
            </div>
            <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: "wrap" }}>
              {rowChips(selected)}
              {selected.plaidPrimary && <span className="chip">{selected.plaidPrimary.toLowerCase().replace(/_/g, " ")}</span>}
              <span className="chip" title="who categorized this row">{selected.categorizationSource === "manual" ? "categorized by you" : selected.categorizationSource === "rule" ? "categorized by rule" : "categorized by bank data"}</span>
            </div>

            {selected.isTransfer ? (
              <div style={{ marginTop: 18 }}>
                <div className="panel muted" style={{ fontSize: 12, padding: "10px 12px", lineHeight: 1.5 }}>
                  {selected.transferPending
                    ? <>⇄ Marked as a transfer — <b style={{ color: "var(--warn)" }}>pending</b>: the system is watching for the matching leg in another account (8-day window). It already stays out of income and spending.</>
                    : <>⇄ Transferred — paired with its matching leg in another account. It carries no category and stays out of income and spending.</>}
                </div>
                <button className="btn-ghost" style={{ marginTop: 10 }} disabled={unmarkTransfer.isPending}
                  onClick={() => {
                    unmarkTransfer.mutate(selected.transactionId);
                    setSelected({ ...selected, isTransfer: false, transferPending: false });
                  }}>
                  Not a transfer — unmark{!selected.transferPending && " (releases both legs)"}
                </button>
              </div>
            ) : (
              <div style={{ marginTop: 18 }}>
                <div className="label" style={{ marginBottom: 8 }}>Category<Tip text="Changing it here recounts the budget and cash-flow views immediately. Setting it counts as a manual categorization — rules won't overwrite it." /></div>
                <select className="input" value={selected.categoryId ?? ""}
                  onChange={(e) => {
                    const categoryId = e.target.value || null;
                    categorize.mutate({ transactionId: selected.transactionId, categoryId });
                    setSelected({ ...selected, categoryId, categorizationSource: "manual" });
                  }}>
                  <option value="">Uncategorized</option>
                  {tops.map((c) => (
                    <optgroup key={c.category_id} label={c.name}>
                      <option value={c.category_id}>{c.name}</option>
                      {cats.filter((x) => x.parent_id === c.category_id && !x.archived).map((x) => (
                        <option key={x.category_id} value={x.category_id}>{c.name} → {x.name}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                {categorize.isPending && <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>Saving…</div>}
                {categorize.isSuccess && !categorize.isPending && <div style={{ fontSize: 11.5, marginTop: 6, color: "var(--accent)" }}>✓ saved</div>}
                <button className="btn-ghost" style={{ marginTop: 14 }} disabled={markTransfer.isPending}
                  title="Money moved to another of your own accounts — leaves the budget now, validated when the matching leg appears within 8 days"
                  onClick={() =>
                    markTransfer.mutate(selected.transactionId, {
                      onSuccess: (r) => setSelected({ ...selected, isTransfer: true, transferPending: !r.matched, categoryId: null }),
                    })
                  }>
                  ⇄ Mark as transfer to another account
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
