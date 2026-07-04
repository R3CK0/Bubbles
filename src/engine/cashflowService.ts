/**
 * engine/cashflowService.ts — Cash Flow page + Overview KPI payloads.
 * Reads flows via the budgeting repo, computes via analytics/cashflow, and
 * returns ECharts-ready shapes (see server/contracts.ts).
 */
import {
  buildSankey,
  computeCashflow,
  decomposeVariance,
  fluxMatrix,
  monthOf,
  monthWindow,
  monthsBetween,
  addMonths,
  relevantFlows,
  roundCents,
  signedFlow,
  type CashflowSummary,
  type FluxMatrix as FluxMatrixResult,
  type SankeyGraph,
  type VarianceDriver,
} from "../analytics/index.js";
import { inLens } from "../analytics/cashflow.js";
import type { EngineContext } from "./context.js";
import { flowsForRange, listCategories, toCategoryNode, transferLegsForRange } from "../db/repositories/budgeting.js";
import { listGoals } from "../db/repositories/planning.js";
import { listDebts } from "../db/repositories/debts.js";
import { listAccounts } from "../db/repository.js";
import { getSetting, setSetting } from "../db/repositories/ops.js";

export function getCashflowSummary(ctx: EngineContext): CashflowSummary {
  const categories = listCategories().map(toCategoryNode);
  const txs = flowsForRange(ctx.range);
  return computeCashflow(txs, categories, ctx.lens, ctx.range);
}

export function getSankey(ctx: EngineContext): SankeyGraph {
  const categories = listCategories().map(toCategoryNode);
  const txs = flowsForRange(ctx.range);
  return buildSankey(txs, categories, ctx.personNames, ctx.lens, ctx.range);
}

/**
 * Flux window centered on the viewed month: 6 months back, the month itself,
 * 5 months ahead (12 columns). Future months come back with no cells — the
 * grid shows them empty so the eye keeps its bearings around "now".
 */
export function getFluxMatrix(ctx: EngineContext, monthCount = 12): FluxMatrixResult {
  const back = Math.floor(monthCount / 2);
  const ahead = monthCount - back - 1;
  const months = monthsBetween(addMonths(ctx.month, -back), addMonths(ctx.month, ahead));
  const first = months[0]!;
  const last = months[months.length - 1]!;
  const txs = flowsForRange({ start: `${first}-01`, end: `${last}-31` });
  const categories = listCategories().map(toCategoryNode);
  return fluxMatrix(txs, categories, months, ctx.lens);
}

export interface CategoryDrilldown {
  categoryId: string;
  month: string;
  total: number;
  transactions: {
    transactionId: string;
    date: string;
    merchant: string | null;
    amount: number;
    pending: boolean;
  }[];
  trend: { month: string; value: number }[];
  drivers: VarianceDriver[];
}

/** The flux-cell drawer: transactions + 6-month trend + variance drivers. */
export function getCategoryDrilldown(ctx: EngineContext, categoryId: string): CategoryDrilldown {
  const monthTxs = relevantFlows(flowsForRange(ctx.range, categoryId), ctx.lens);

  const trendMonths = monthsBetween(addMonths(ctx.month, -5), ctx.month);
  const trendStart = `${trendMonths[0]!}-01`;
  const trendTxs = relevantFlows(
    flowsForRange({ start: trendStart, end: ctx.range.end }, categoryId),
    ctx.lens,
  );
  const trend = trendMonths.map((month) => ({
    month,
    value: roundCents(
      trendTxs
        .filter((t) => monthOf(t.date) === month)
        .reduce((sum, t) => sum + Math.abs(signedFlow(t)), 0),
    ),
  }));

  const baselineMonths = trendMonths.slice(0, -1);
  const baselineTxs = trendTxs.filter((t) => monthOf(t.date) !== ctx.month);
  const drivers = decomposeVariance(monthTxs, baselineTxs, Math.max(1, baselineMonths.length));

  return {
    categoryId,
    month: ctx.month,
    total: roundCents(monthTxs.reduce((s, t) => s + Math.abs(signedFlow(t)), 0)),
    transactions: monthTxs
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .map((t) => ({
        transactionId: t.transactionId,
        date: t.date,
        merchant: t.merchantName ?? t.payee,
        amount: roundCents(Math.abs(signedFlow(t))),
        pending: t.pending,
      })),
    trend,
    drivers,
  };
}

export { monthWindow };

// ---- income drill-down: sources → receiving accounts → deposits ----

export interface IncomeBreakdown {
  month: string;
  total: number;
  sources: {
    /** Same naming as the sankey/pie: person for salary streams, category name for named streams (Buildings). */
    name: string;
    total: number;
    accounts: {
      accountId: string;
      accountName: string;
      mask: string | null;
      amount: number;
      deposits: { transactionId: string; date: string; amount: number; merchant: string | null }[];
    }[];
  }[];
}

/**
 * The Money-in side panel: each income source with the account(s) the money
 * actually landed in. Source naming mirrors buildSankey so the panel's groups
 * line up 1:1 with the pie slices on the card.
 */
export function getIncomeBreakdown(ctx: EngineContext): IncomeBreakdown {
  const categories = listCategories().map(toCategoryNode);
  const index = new Map(categories.map((c) => [c.categoryId, c]));
  const flows = relevantFlows(flowsForRange(ctx.range), ctx.lens, ctx.range);
  const accountsById = new Map(listAccounts().map((a) => [a.account_id, a]));

  const isIncomeTx = (t: (typeof flows)[number]) => {
    const cat = t.categoryId ? index.get(t.categoryId) : undefined;
    return cat ? cat.kind === "income" : signedFlow(t) > 0;
  };
  const sourceOf = (t: (typeof flows)[number]) => {
    const cat = t.categoryId ? index.get(t.categoryId) : undefined;
    const isNamedStream = cat && cat.parentId !== null && cat.name.toLowerCase() !== "salary";
    return isNamedStream ? cat.name : (ctx.personNames.get(t.personId ?? "") ?? "Income");
  };

  const sources = new Map<string, Map<string, { amount: number; deposits: IncomeBreakdown["sources"][number]["accounts"][number]["deposits"] }>>();
  let total = 0;
  for (const t of flows) {
    if (!isIncomeTx(t)) continue;
    const flow = signedFlow(t);
    if (flow <= 0) continue; // refunds/chargebacks against an income category
    total += flow;
    const byAccount = sources.get(sourceOf(t)) ?? new Map();
    const acc = byAccount.get(t.accountId) ?? { amount: 0, deposits: [] };
    acc.amount += flow;
    acc.deposits.push({
      transactionId: t.transactionId,
      date: t.date,
      amount: roundCents(flow),
      merchant: t.merchantName ?? t.payee,
    });
    byAccount.set(t.accountId, acc);
    sources.set(sourceOf(t), byAccount);
  }

  return {
    month: ctx.month,
    total: roundCents(total),
    sources: [...sources.entries()]
      .map(([name, byAccount]) => {
        const accounts = [...byAccount.entries()]
          .map(([accountId, acc]) => {
            const row = accountsById.get(accountId);
            return {
              accountId,
              accountName: row?.name ?? row?.official_name ?? accountId,
              mask: row?.mask ?? null,
              amount: roundCents(acc.amount),
              deposits: acc.deposits.sort((a, b) => (a.date < b.date ? 1 : -1)),
            };
          })
          .sort((a, b) => b.amount - a.amount);
        return { name, total: roundCents(accounts.reduce((s, a) => s + a.amount, 0)), accounts };
      })
      .sort((a, b) => b.total - a.total),
  };
}

// ---- account flows: how money moved between our own accounts ----

export interface AccountFlowsView {
  month: string;
  totalMoved: number;
  debtPayments: number;
  toSavings: number;
  transferCount: number;
  accounts: {
    accountId: string;
    name: string;
    mask: string | null;
    personId: string | null;
    type: string | null;
    subtype: string | null;
    registeredType: string | null;
    /** account is a credit/loan account linked to a tracked debt */
    debtLinked: boolean;
  }[];
  flows: {
    fromAccountId: string;
    toAccountId: string;
    total: number;
    count: number;
    kind: "debt" | "save" | "move";
    items: { date: string; amount: number }[];
  }[];
}

/**
 * The Account Flows page: every marked transfer pair in the month, aggregated
 * by (from account → to account). The outflow leg (Plaid amount > 0) names
 * the source, the inflow leg the destination. Destinations that are credit/
 * loan accounts (or linked to a debt) classify as debt payments; registered
 * or savings-type destinations classify as savings.
 */
export function getAccountFlows(ctx: EngineContext): AccountFlowsView {
  const legs = transferLegsForRange(ctx.range);
  const accountsById = new Map(listAccounts().map((a) => [a.account_id, a]));
  const debtAccounts = new Set(
    listDebts("active").map((d) => d.account_id).filter((id): id is string => id !== null),
  );

  const byGroup = new Map<string, typeof legs>();
  for (const leg of legs) {
    const list = byGroup.get(leg.transfer_group_id) ?? [];
    list.push(leg);
    byGroup.set(leg.transfer_group_id, list);
  }

  const kindOf = (toId: string): AccountFlowsView["flows"][number]["kind"] => {
    const acc = accountsById.get(toId);
    if (!acc) return "move";
    if (debtAccounts.has(toId) || acc.type === "credit" || acc.type === "loan") return "debt";
    if (acc.registered_type || acc.subtype === "savings") return "save";
    return "move";
  };

  const pairs = new Map<string, AccountFlowsView["flows"][number]>();
  const used = new Set<string>();
  let totalMoved = 0;
  let debtPayments = 0;
  let toSavings = 0;
  let transferCount = 0;
  for (const group of byGroup.values()) {
    const out = group.find((l) => l.amount > 0);
    const inn = group.find((l) => l.amount < 0);
    if (!out || !inn) continue; // half-pairs (other leg outside the month)
    const amount = roundCents(out.amount);
    const key = `${out.account_id}|${inn.account_id}`;
    const flow = pairs.get(key) ?? {
      fromAccountId: out.account_id,
      toAccountId: inn.account_id,
      total: 0,
      count: 0,
      kind: kindOf(inn.account_id),
      items: [],
    };
    flow.total = roundCents(flow.total + amount);
    flow.count++;
    flow.items.push({ date: out.date, amount });
    pairs.set(key, flow);
    used.add(out.account_id);
    used.add(inn.account_id);
    totalMoved = roundCents(totalMoved + amount);
    transferCount++;
    if (flow.kind === "debt") debtPayments = roundCents(debtPayments + amount);
    if (flow.kind === "save") toSavings = roundCents(toSavings + amount);
  }

  return {
    month: ctx.month,
    totalMoved,
    debtPayments,
    toSavings,
    transferCount,
    accounts: [...used].map((accountId) => {
      const a = accountsById.get(accountId);
      return {
        accountId,
        name: a?.name ?? a?.official_name ?? accountId,
        mask: a?.mask ?? null,
        personId: a?.person_id ?? null,
        type: a?.type ?? null,
        subtype: a?.subtype ?? null,
        registeredType: a?.registered_type ?? null,
        debtLinked: debtAccounts.has(accountId),
      };
    }),
    flows: [...pairs.values()].sort((a, b) => b.total - a.total),
  };
}

// ---- persisted card layout for the Account Flows diagram ----

const FLOW_LAYOUT_KEY = "account_flow_layout";

export type FlowLayout = Record<string, { x: number; y: number }>;

export function getFlowLayout(): FlowLayout {
  const raw = getSetting(FLOW_LAYOUT_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw) as FlowLayout;
  } catch {
    return {};
  }
}

export function saveFlowLayout(layout: FlowLayout): void {
  setSetting(FLOW_LAYOUT_KEY, JSON.stringify(layout));
}

// ---- what the budget deliberately ignores ----

export interface ExcludedSummary {
  reimbursed: {
    work: { spent: number; repaid: number };
    buildings: { spent: number; repaid: number };
  };
  goals: { goalId: string; name: string; spent: number }[];
}

/** Month totals for flows relevantFlows() drops: work/buildings-reimbursed
 *  rows (spent + the matching deposits) and goal-tagged spending. */
export function getExcludedSummary(ctx: EngineContext): ExcludedSummary {
  const flows = flowsForRange(ctx.range).filter((t) => !t.isTransfer && inLens(t.personId, ctx.lens));
  const bucket = () => ({ spent: 0, repaid: 0 });
  const reimbursed = { work: bucket(), buildings: bucket() };
  const perGoal = new Map<string, number>();

  for (const t of flows) {
    const flow = signedFlow(t);
    if (t.reimbursedBy) {
      const b = reimbursed[t.reimbursedBy];
      if (flow < 0) b.spent += -flow;
      else b.repaid += flow;
    } else if (t.goalId) {
      // net spend: refunds tagged to the goal reduce it
      perGoal.set(t.goalId, (perGoal.get(t.goalId) ?? 0) - flow);
    }
  }
  for (const b of [reimbursed.work, reimbursed.buildings]) {
    b.spent = roundCents(b.spent);
    b.repaid = roundCents(b.repaid);
  }
  const names = new Map(listGoals("all").map((g) => [g.goal_id, g.name]));
  return {
    reimbursed,
    goals: [...perGoal.entries()]
      .map(([goalId, spent]) => ({ goalId, name: names.get(goalId) ?? goalId, spent: roundCents(spent) }))
      .sort((a, b) => b.spent - a.spent),
  };
}
