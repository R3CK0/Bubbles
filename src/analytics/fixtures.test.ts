/** Shared fixture builders for analytics tests. */
import type { CategoryNode, FlowTx } from "./types.js";

export function tx(over: Partial<FlowTx> & { transactionId: string; amount: number; date: string }): FlowTx {
  return {
    accountId: "acc-1",
    personId: "nick",
    currency: "CAD",
    merchantName: null,
    payee: null,
    categoryId: null,
    categorizationSource: "plaid",
    plaidPrimary: null,
    plaidDetailed: null,
    isTransfer: false,
    reimbursedBy: null,
    pending: false,
    ...over,
  };
}

export const CATEGORIES: CategoryNode[] = [
  { categoryId: "income", parentId: null, name: "Income", kind: "income", sortOrder: 0 },
  { categoryId: "income-salary", parentId: "income", name: "Salary", kind: "income", sortOrder: 1 },
  { categoryId: "income-buildings", parentId: "income", name: "Buildings", kind: "income", sortOrder: 2 },
  { categoryId: "essentials", parentId: null, name: "Essentials", kind: "expense", sortOrder: 3 },
  { categoryId: "essentials-groceries", parentId: "essentials", name: "Groceries", kind: "expense", sortOrder: 4 },
  { categoryId: "essentials-restaurants", parentId: "essentials", name: "Restaurants", kind: "expense", sortOrder: 5 },
  { categoryId: "savings", parentId: null, name: "Savings", kind: "savings", sortOrder: 6 },
];

// vitest treats this file as a suite; give it a trivial test so it doesn't fail.
import { it } from "vitest";
it("fixtures load", () => {});
