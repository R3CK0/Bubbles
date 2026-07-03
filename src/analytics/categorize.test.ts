import { describe, expect, it } from "vitest";
import { applyRules, resolveCategory, suggestCategory, type CategoryRule } from "./categorize.js";
import { tx } from "./fixtures.test.js";

function rule(over: Partial<CategoryRule> & { ruleId: string; categoryId: string }): CategoryRule {
  return {
    priority: 50,
    merchantPattern: null,
    payeePattern: null,
    plaidCategory: null,
    accountId: null,
    amountMin: null,
    amountMax: null,
    active: true,
    ...over,
  };
}

describe("resolveCategory", () => {
  const rules = [
    rule({ ruleId: "r-plaid", categoryId: "essentials-groceries", plaidCategory: "FOOD_AND_DRINK_GROCERIES", priority: 50 }),
    rule({ ruleId: "r-costco", categoryId: "essentials-groceries", merchantPattern: "costco", priority: 10 }),
    rule({ ruleId: "r-costco-gas", categoryId: "essentials-car", merchantPattern: "costco gas", priority: 5 }),
  ];

  it("lower priority number wins", () => {
    const t = tx({ transactionId: "t", amount: 80, date: "2026-06-01", merchantName: "Costco Gas #55", plaidPrimary: "FOOD_AND_DRINK_GROCERIES" });
    expect(resolveCategory(t, rules)).toBe("essentials-car");
  });

  it("matches plaid detailed or primary, case-insensitive merchants", () => {
    expect(resolveCategory(tx({ transactionId: "a", amount: 5, date: "2026-06-01", plaidDetailed: "FOOD_AND_DRINK_GROCERIES" }), rules)).toBe("essentials-groceries");
    expect(resolveCategory(tx({ transactionId: "b", amount: 5, date: "2026-06-01", merchantName: "COSTCO WHOLESALE" }), rules)).toBe("essentials-groceries");
    expect(resolveCategory(tx({ transactionId: "c", amount: 5, date: "2026-06-01", merchantName: "Metro" }), rules)).toBeNull();
  });

  it("a rule with no conditions matches nothing", () => {
    expect(resolveCategory(tx({ transactionId: "d", amount: 5, date: "2026-06-01" }), [rule({ ruleId: "r0", categoryId: "x" })])).toBeNull();
  });
});

describe("applyRules", () => {
  it("never patches manual rows and skips already-correct rows", () => {
    const rules = [rule({ ruleId: "r", categoryId: "essentials-groceries", merchantPattern: "metro" })];
    const txs = [
      tx({ transactionId: "manual", amount: 10, date: "2026-06-01", merchantName: "Metro", categoryId: "other", categorizationSource: "manual" }),
      tx({ transactionId: "wrong", amount: 10, date: "2026-06-01", merchantName: "Metro", categoryId: "other", categorizationSource: "plaid" }),
      tx({ transactionId: "right", amount: 10, date: "2026-06-01", merchantName: "Metro", categoryId: "essentials-groceries", categorizationSource: "rule" }),
    ];
    expect(applyRules(txs, rules)).toEqual([{ transactionId: "wrong", categoryId: "essentials-groceries" }]);
  });
});

describe("suggestCategory", () => {
  it("suggests the dominant historical category for the merchant", () => {
    const history = [
      tx({ transactionId: "h1", amount: 10, date: "2026-05-01", merchantName: "Metro", categoryId: "essentials-groceries" }),
      tx({ transactionId: "h2", amount: 10, date: "2026-05-08", merchantName: "Metro", categoryId: "essentials-groceries" }),
      tx({ transactionId: "h3", amount: 10, date: "2026-05-09", merchantName: "Metro", categoryId: "other" }),
    ];
    expect(suggestCategory(tx({ transactionId: "n", amount: 12, date: "2026-06-01", merchantName: "METRO" }), history)).toBe("essentials-groceries");
    expect(suggestCategory(tx({ transactionId: "n2", amount: 12, date: "2026-06-01" }), history)).toBeNull();
  });
});
