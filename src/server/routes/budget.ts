/**
 * server/routes/budget.ts — HTTP surface for budgetService +
 * categorizationService (they share the Budget page). DB-only: no vaultGuard.
 */
import { Router } from "express";
import { z } from "zod";
import { buildContext } from "../../engine/context.js";
import {
  getBudgetVersions,
  getBudgetView,
  getVarianceNarratives,
  updateBudgetLines,
} from "../../engine/budgetService.js";
import {
  categorizeManually,
  deleteRule,
  getInbox,
  saveRule,
} from "../../engine/categorizationService.js";
import { listCategories, listRules, setTransactionFlags, upsertCategory } from "../../db/repositories/budgeting.js";
import {
  budgetUpdateSchema,
  categorizeSchema,
  categorySchema,
  ruleSchema,
  transactionFlagsSchema,
} from "../contracts.js";
import { requireParam } from "../params.js";

export const budgetRouter = Router();

budgetRouter.get("/api/budget", (req, res) => {
  res.json(getBudgetView(buildContext(req.query)));
});

budgetRouter.put("/api/budget/lines", (req, res) => {
  const body = budgetUpdateSchema.parse(req.body);
  const version = updateBudgetLines(
    body.effectiveFrom,
    body.lines.map((l) => ({
      categoryId: l.categoryId,
      personId: l.personId,
      monthlyAmount: l.monthlyAmount,
    })),
    body.name,
  );
  res.json({ version });
});

budgetRouter.get("/api/budget/versions", (_req, res) => {
  res.json({ versions: getBudgetVersions() });
});

budgetRouter.get("/api/budget/variances", (req, res) => {
  res.json({ narratives: getVarianceNarratives(buildContext(req.query)) });
});

budgetRouter.get("/api/categories", (req, res) => {
  const includeArchived = req.query.archived === "true";
  res.json({ categories: listCategories(includeArchived) });
});

budgetRouter.post("/api/categories", (req, res) => {
  const body = categorySchema.parse(req.body);
  upsertCategory({
    category_id: body.categoryId,
    parent_id: body.parentId,
    name: body.name,
    kind: body.kind,
    sort_order: body.sortOrder,
    archived: body.archived ? 1 : 0,
  });
  res.status(201).json({ ok: true });
});

budgetRouter.get("/api/categories/rules", (_req, res) => {
  res.json({ rules: listRules(false) });
});

budgetRouter.post("/api/categories/rules", (req, res) => {
  const body = ruleSchema.parse(req.body);
  const { retroactiveMonths, ...rule } = body;
  res.status(201).json(saveRule(rule, retroactiveMonths));
});

budgetRouter.delete("/api/categories/rules/:ruleId", (req, res) => {
  deleteRule(requireParam(req, "ruleId"));
  res.json({ ok: true });
});

const inboxQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(25) });

budgetRouter.get("/api/categories/inbox", (req, res) => {
  const { limit } = inboxQuery.parse({ limit: req.query.limit });
  res.json(getInbox(limit));
});

budgetRouter.post("/api/transactions/:transactionId/categorize", (req, res) => {
  const body = categorizeSchema.parse(req.body);
  const changed = categorizeManually(requireParam(req, "transactionId"), body.categoryId);
  res.json({ changed });
});

/** Flag a transaction as work/buildings-reimbursed or as goal spending —
 *  either way it leaves the household budget. */
budgetRouter.patch("/api/transactions/:transactionId/flags", (req, res) => {
  const body = transactionFlagsSchema.parse(req.body);
  const changed = setTransactionFlags(requireParam(req, "transactionId"), body);
  res.json({ changed });
});
