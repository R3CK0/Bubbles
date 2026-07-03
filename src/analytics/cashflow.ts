/**
 * analytics/cashflow.ts — “where is our money going”. Pure.
 *
 * Flow rules, applied uniformly by relevantFlows():
 *   - transfers between own accounts are excluded (not income, not spend)
 *   - reimbursed rows (work / buildings pay) are excluded from household cost
 *   - goal-tagged rows are excluded too (they spend the goal's envelope)
 *   - pending rows count (the dashboard should feel live; Plaid replaces them
 *     with posted rows on settle)
 *   - person lens: rows owned by that person + joint rows; combined: all
 */
import type {
  CategoryNode,
  DateRange,
  FlowTx,
  HeatmapCell,
  Lens,
  MonthISO,
  SankeyGraph,
} from "./types.js";
import { COMBINED } from "./types.js";
import { groupSum, roundCents, signedFlow, sumBy } from "./money.js";
import { monthOf, monthsBetween } from "./calendar.js";

export interface CategoryAmount {
  categoryId: string | null;
  name: string;
  kind: CategoryNode["kind"] | "uncategorized";
  parentId: string | null;
  amount: number;
}

export interface CashflowSummary {
  income: number;
  spend: number;
  net: number;
  byCategory: CategoryAmount[];
}

export function inLens(personId: string | null, lens: Lens): boolean {
  return lens === COMBINED || personId === null || personId === lens;
}

/** The one flow filter every cashflow computation shares. */
export function relevantFlows(txs: FlowTx[], lens: Lens, range?: DateRange): FlowTx[] {
  return txs.filter(
    (t) =>
      !t.isTransfer &&
      t.reimbursedBy === null &&
      !t.goalId &&
      inLens(t.personId, lens) &&
      (!range || (t.date >= range.start && t.date <= range.end)),
  );
}

function categoryIndex(categories: CategoryNode[]): Map<string, CategoryNode> {
  return new Map(categories.map((c) => [c.categoryId, c]));
}

function isIncome(tx: FlowTx, index: Map<string, CategoryNode>): boolean {
  const cat = tx.categoryId ? index.get(tx.categoryId) : undefined;
  if (cat) return cat.kind === "income";
  return signedFlow(tx) > 0;
}

export function computeCashflow(
  txs: FlowTx[],
  categories: CategoryNode[],
  lens: Lens,
  range: DateRange,
): CashflowSummary {
  const index = categoryIndex(categories);
  const flows = relevantFlows(txs, lens, range);

  const income = sumBy(
    flows.filter((t) => isIncome(t, index)),
    (t) => signedFlow(t),
  );
  const spendRows = flows.filter((t) => !isIncome(t, index));
  const spend = roundCents(-sumBy(spendRows, (t) => signedFlow(t)));

  const perCategory = groupSum(
    spendRows,
    (t) => t.categoryId ?? "uncategorized",
    (t) => -signedFlow(t),
  );
  const byCategory: CategoryAmount[] = [...perCategory.entries()]
    .map(([categoryId, amount]) => {
      const cat = index.get(categoryId);
      return {
        categoryId: cat ? categoryId : null,
        name: cat?.name ?? "Uncategorized",
        kind: cat?.kind ?? ("uncategorized" as const),
        parentId: cat?.parentId ?? null,
        amount,
      };
    })
    .sort((a, b) => b.amount - a.amount);

  return { income, spend, net: roundCents(income - spend), byCategory };
}

/** Roll a category up to its top-level ancestor. */
export function topLevelOf(categoryId: string, index: Map<string, CategoryNode>): string {
  let current = index.get(categoryId);
  while (current && current.parentId !== null) {
    const parent = index.get(current.parentId);
    if (!parent) break;
    current = parent;
  }
  return current?.categoryId ?? categoryId;
}

/**
 * Income sources → Household → top-level groups → child categories.
 * An “Unallocated” sink absorbs net savings so the diagram balances.
 */
export function buildSankey(
  txs: FlowTx[],
  categories: CategoryNode[],
  personNames: Map<string, string>,
  lens: Lens,
  range: DateRange,
): SankeyGraph {
  const index = categoryIndex(categories);
  const flows = relevantFlows(txs, lens, range);
  const HOUSEHOLD = "Household";

  const links = new Map<string, number>();
  const nodes = new Set<string>([HOUSEHOLD]);
  const add = (source: string, target: string, value: number) => {
    if (value <= 0) return;
    nodes.add(source);
    nodes.add(target);
    const key = `${source}→${target}`;
    links.set(key, roundCents((links.get(key) ?? 0) + value));
  };

  let totalIn = 0;
  let totalOut = 0;
  for (const tx of flows) {
    const flow = signedFlow(tx);
    if (isIncome(tx, index)) {
      // Personal salary streams read as the person; named streams (Buildings)
      // read as their category.
      const cat = tx.categoryId ? index.get(tx.categoryId) : undefined;
      const isNamedStream = cat && cat.parentId !== null && cat.name.toLowerCase() !== "salary";
      const source = isNamedStream
        ? cat.name
        : (personNames.get(tx.personId ?? "") ?? "Income");
      add(source, HOUSEHOLD, flow);
      totalIn += flow;
    } else {
      const spend = -flow;
      if (spend <= 0) continue; // refunds net against the group implicitly
      const catId = tx.categoryId;
      if (!catId) {
        add(HOUSEHOLD, "Uncategorized", spend);
      } else {
        const top = topLevelOf(catId, index);
        const topName = index.get(top)?.name ?? "Other";
        add(HOUSEHOLD, topName, spend);
        if (top !== catId) {
          add(topName, index.get(catId)?.name ?? catId, spend);
        }
      }
      totalOut += spend;
    }
  }
  if (totalIn - totalOut > 0.005) add(HOUSEHOLD, "Unallocated", roundCents(totalIn - totalOut));

  return {
    nodes: [...nodes].map((name) => ({ name })),
    links: [...links.entries()].map(([key, value]) => {
      const [source, target] = key.split("→") as [string, string];
      return { source, target, value };
    }),
  };
}

export interface FluxMatrix {
  months: MonthISO[];
  categories: { categoryId: string; name: string; kind: CategoryNode["kind"] }[];
  cells: HeatmapCell[];
}

/** Month × top-level-category actuals (income positive, spend positive). */
export function fluxMatrix(
  txs: FlowTx[],
  categories: CategoryNode[],
  months: MonthISO[],
  lens: Lens,
): FluxMatrix {
  const first = months[0];
  const last = months[months.length - 1];
  if (!first || !last) return { months: [], categories: [], cells: [] };
  const index = categoryIndex(categories);
  const range = { start: `${first}-01`, end: `${last}-31` };
  const flows = relevantFlows(txs, lens, range);

  const tops = categories
    .filter((c) => c.parentId === null)
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const sums = groupSum(
    flows,
    (t) => {
      const top = t.categoryId ? topLevelOf(t.categoryId, index) : "uncategorized";
      return `${monthOf(t.date)}|${top}`;
    },
    (t) => Math.abs(signedFlow(t)),
  );

  const cells: HeatmapCell[] = [];
  for (const month of monthsBetween(monthOf(range.start), monthOf(range.end))) {
    for (const top of tops) {
      const value = sums.get(`${month}|${top.categoryId}`);
      if (value !== undefined) cells.push({ month, categoryId: top.categoryId, value });
    }
    const unc = sums.get(`${month}|uncategorized`);
    if (unc !== undefined) cells.push({ month, categoryId: "uncategorized", value: unc });
  }

  return {
    months,
    categories: tops.map((c) => ({ categoryId: c.categoryId, name: c.name, kind: c.kind })),
    cells,
  };
}
