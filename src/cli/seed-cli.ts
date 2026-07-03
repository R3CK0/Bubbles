/**
 * seed-cli.ts — deliberate one-time mapping of Joint_Finances_06-2026.xlsx
 * into the schema-v2 tables: category tree, June-2026 budget version,
 * plaid-category rules, debts, wedding/Greece/XREAL goals, and the recurring
 * bill/subscription registry.
 *
 * Usage: npm run seed [-- --file <path>] [--force]
 * Idempotency: refuses to run if a budget version already exists (pass
 * --force to wipe and re-seed the seeded tables — never touches transactions).
 *
 * APR NOTE: debt APRs are documented estimates (statement rates weren't in
 * the workbook) — update via PATCH /api/debts/:id once known.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import ExcelJS from "exceljs";
import { Command } from "commander";
import { getDb } from "../db/db.js";
import {
  createBudgetVersion,
  upsertCategory,
  upsertRule,
} from "../db/repositories/budgeting.js";
import { roundCents } from "../analytics/money.js";
import { addDays, nextOccurrence } from "../analytics/calendar.js";

const BUDGET_MONTH = "2026-06";
const ANCHOR = `${BUDGET_MONTH}-01`;

type Kind = "income" | "expense" | "savings" | "transfer";

interface SectionDef {
  header: string;
  stopPrefixes: string[];
  categoryId: string;
  name: string;
  kind: Kind;
  /** Rows here become recurring_payments (all rows for subs sections). */
  recurring: "all" | string[] | "none";
}

const SECTIONS: SectionDef[] = [
  { header: "Money In", stopPrefixes: ["Total Income"], categoryId: "income", name: "Income", kind: "income", recurring: "none" },
  {
    header: "Essentials",
    stopPrefixes: ["Total Essentials"],
    categoryId: "essentials",
    name: "Essentials",
    kind: "expense",
    recurring: ["Rent", "Electricity", "Internet", "Home insurance", "Car", "Car insurance", "Car charging", "Loan Repayment", "Cellphone", "Gym"],
  },
  { header: "Entertainement", stopPrefixes: ["Total Entertainement"], categoryId: "subs-entertainment", name: "Entertainment subscriptions", kind: "expense", recurring: "all" },
  { header: "Lifestyle", stopPrefixes: ["Total Lifestyle"], categoryId: "subs-lifestyle", name: "Lifestyle subscriptions", kind: "expense", recurring: "all" },
  { header: "Work", stopPrefixes: ["Total Work", "Expensed Costs", "Total Actual Costs"], categoryId: "subs-work", name: "Work subscriptions", kind: "expense", recurring: "all" },
  { header: "Vacation", stopPrefixes: ["Total Vacation"], categoryId: "vacation", name: "Vacation", kind: "savings", recurring: "none" },
  { header: "Savings", stopPrefixes: ["Total Savings"], categoryId: "savings", name: "Savings", kind: "savings", recurring: "none" },
  { header: "Donations", stopPrefixes: ["Total Donations"], categoryId: "donations", name: "Donations", kind: "expense", recurring: "all" },
  { header: "Other", stopPrefixes: ["Total Other"], categoryId: "other", name: "Other", kind: "expense", recurring: "none" },
];

const SKIP_PREFIXES = ["Total", "Combined", "Remaining", "Subtotal", "subtotal", "Subscriptions", "Extra expenses", "Alcohol"];

interface ParsedLine {
  label: string;
  shanthi: number;
  nick: number;
  note: string | null;
  section: SectionDef;
}

function cellNum(v: ExcelJS.CellValue): number {
  if (typeof v === "number") return v;
  if (v && typeof v === "object" && "result" in v && typeof v.result === "number") return v.result;
  return 0;
}

function cellStr(v: ExcelJS.CellValue): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (v && typeof v === "object" && "result" in v && typeof v.result === "string") {
    return v.result.trim() || null;
  }
  return null;
}

function slugify(label: string, used: Set<string>): string {
  let base = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) base = "item";
  let slug = base;
  for (let i = 2; used.has(slug); i++) slug = `${base}-${i}`;
  used.add(slug);
  return slug;
}

function parseFinancesSheet(ws: ExcelJS.Worksheet): ParsedLine[] {
  const lines: ParsedLine[] = [];
  let current: SectionDef | null = null;
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const label = cellStr(row.getCell(1).value);
    if (!label) continue;

    const section = SECTIONS.find((s) => s.header === label);
    if (section) {
      current = section;
      continue;
    }
    if (!current) continue;
    if (current.stopPrefixes.some((p) => label.startsWith(p))) {
      // Stay in section only past soft stops (Work has mid-section stops).
      if (label.startsWith("Total " + current.header) || label.startsWith(current.stopPrefixes[0]!)) {
        current = null;
      }
      continue;
    }
    if (SKIP_PREFIXES.some((p) => label.startsWith(p))) continue;

    const shanthi = roundCents(cellNum(row.getCell(2).value));
    const nick = roundCents(cellNum(row.getCell(3).value));
    const note = cellStr(row.getCell(4).value);
    if (shanthi <= 0 && nick <= 0) continue;
    lines.push({ label, shanthi, nick, note, section: current });
  }
  return lines;
}

interface SeededDebt {
  id: string;
  label: string;
  kind: string;
  balance: number;
  apr: number;
  minPayment: number | null;
}

function parseAssetsSheet(ws: ExcelJS.Worksheet): SeededDebt[] {
  const wanted: Record<string, { id: string; kind: string; apr: number; minPayment: number | null }> = {
    "Credit Cart": { id: "debt-credit-card", kind: "credit_card", apr: 20.99, minPayment: null },
    "Student Loan": { id: "debt-student-loan", kind: "student_loan", apr: 5.95, minPayment: 832.07 },
    "Student Line of credit": { id: "debt-student-loc", kind: "line_of_credit", apr: 7.2, minPayment: null },
  };
  const out: SeededDebt[] = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const label = cellStr(row.getCell(1).value);
    if (!label || !(label in wanted)) continue;
    const spec = wanted[label]!;
    const nick = roundCents(cellNum(row.getCell(2).value));
    if (nick <= 0) continue;
    out.push({ id: spec.id, label, kind: spec.kind, balance: nick, apr: spec.apr, minPayment: spec.minPayment });
  }
  return out;
}

interface UpcomingItem {
  label: string;
  amount: number;
  note: string | null;
}

function parseUpcomingSheet(ws: ExcelJS.Worksheet): UpcomingItem[] {
  const out: UpcomingItem[] = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const label = cellStr(row.getCell(1).value);
    const amount = roundCents(cellNum(row.getCell(2).value));
    if (label && amount > 0) out.push({ label, amount, note: cellStr(row.getCell(3).value) });
  }
  return out;
}

/** Plaid personal_finance_category → seeded category rules. */
const PLAID_RULES: [plaidCategory: string, categoryId: string, priority: number][] = [
  ["FOOD_AND_DRINK_GROCERIES", "essentials-groceries", 50],
  ["FOOD_AND_DRINK_RESTAURANT", "essentials-restaurants", 50],
  ["FOOD_AND_DRINK", "essentials-restaurants", 90],
  ["RENT_AND_UTILITIES_RENT", "essentials-rent", 50],
  ["RENT_AND_UTILITIES_GAS_AND_ELECTRICITY", "essentials-electricity", 50],
  ["RENT_AND_UTILITIES_INTERNET_AND_CABLE", "essentials-internet", 50],
  ["RENT_AND_UTILITIES_TELEPHONE", "essentials-cellphone", 50],
  ["TRANSPORTATION", "essentials-transport-taxi-bixi-metro", 90],
  ["MEDICAL", "essentials-medical", 90],
  ["GENERAL_MERCHANDISE_CLOTHING_AND_ACCESSORIES", "essentials-clothing", 50],
  ["PERSONAL_CARE", "essentials-beauty-self-care", 90],
  ["ENTERTAINMENT", "subs-entertainment", 95],
  ["INCOME", "income-income", 90],
];

const MERCHANT_RULES: [pattern: string, categoryId: string][] = [["costco", "essentials-groceries"]];

async function main(): Promise<void> {
  const program = new Command()
    .option("--file <path>", "workbook path", path.resolve("Joint_Finances_06-2026.xlsx"))
    .option("--force", "wipe previously-seeded tables and re-seed", false)
    .parse(process.argv);
  const opts = program.opts<{ file: string; force: boolean }>();

  const db = getDb();
  const already = db.prepare(`SELECT COUNT(*) AS n FROM budget_versions`).get() as { n: number };
  if (already.n > 0 && !opts.force) {
    console.error("Budget versions already exist — re-run with --force to wipe seeded tables and re-seed.");
    process.exit(1);
  }
  if (opts.force) {
    db.transaction(() => {
      for (const table of ["budget_lines", "budget_versions", "category_rules", "goal_line_items", "goals", "recurring_payments", "debt_rate_history", "debts"]) {
        db.prepare(`DELETE FROM ${table}`).run();
      }
      db.prepare(`UPDATE transactions SET category_id = NULL WHERE categorization_source != 'manual'`).run();
      db.prepare(`DELETE FROM categories`).run();
    })();
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(opts.file);
  const finances = wb.getWorksheet("Finances");
  const assets = wb.getWorksheet("Assets");
  const upcoming = wb.getWorksheet("Upcomming Expenses");
  if (!finances || !assets || !upcoming) {
    throw new Error("workbook is missing an expected sheet (Finances / Assets / Upcomming Expenses)");
  }

  const now = new Date().toISOString();
  const today = now.slice(0, 10);
  const lines = parseFinancesSheet(finances);

  // 1. Categories: top-level per section, child per line.
  let sort = 0;
  for (const s of SECTIONS) {
    upsertCategory({ category_id: s.categoryId, parent_id: null, name: s.name, kind: s.kind, sort_order: sort++, archived: 0 });
  }
  const usedSlugs = new Set<string>();
  const childId = new Map<ParsedLine, string>();
  for (const line of lines) {
    const id = `${line.section.categoryId}-${slugify(line.label, usedSlugs)}`;
    childId.set(line, id);
    upsertCategory({ category_id: id, parent_id: line.section.categoryId, name: line.label, kind: line.section.kind, sort_order: sort++, archived: 0 });
  }

  // 2. June-2026 budget version (per-person lines where amounts exist).
  // Reimbursed lines (Work Pays / Buildings Pay) are excluded: the engine nets
  // reimbursed transactions out of actuals, so the budget must be net too —
  // they stay in the recurring registry (with reimbursed_by) for bill tracking.
  const REIMBURSED_NOTES = new Set(["Work Pays", "Buildings Pay"]);
  const budgetLines: { category_id: string; person_id: string | null; monthly_amount: number }[] = [];
  for (const line of lines) {
    if (line.note && REIMBURSED_NOTES.has(line.note)) continue;
    const id = childId.get(line)!;
    if (line.shanthi > 0) budgetLines.push({ category_id: id, person_id: "shanthi", monthly_amount: line.shanthi });
    if (line.nick > 0) budgetLines.push({ category_id: id, person_id: "nick", monthly_amount: line.nick });
  }
  createBudgetVersion("June 2026 baseline (workbook)", ANCHOR, `Seeded from ${path.basename(opts.file)}`, budgetLines, now);

  // 3. Category rules: plaid-category fallbacks + merchant overrides.
  const categoryIds = new Set(db.prepare(`SELECT category_id FROM categories`).all().map((r) => (r as { category_id: string }).category_id));
  let rulesSeeded = 0;
  for (const [plaidCategory, categoryId, priority] of PLAID_RULES) {
    if (!categoryIds.has(categoryId)) continue;
    upsertRule({ rule_id: `seed-plaid-${plaidCategory.toLowerCase()}`, priority, merchant_pattern: null, payee_pattern: null, plaid_category: plaidCategory, account_id: null, amount_min: null, amount_max: null, category_id: categoryId, goal_id: null, goal_line_id: null, source: "manual", locked_at: null, active: 1, created_at: now });
    rulesSeeded++;
  }
  for (const [pattern, categoryId] of MERCHANT_RULES) {
    if (!categoryIds.has(categoryId)) continue;
    upsertRule({ rule_id: `seed-merchant-${pattern}`, priority: 10, merchant_pattern: pattern, payee_pattern: null, plaid_category: null, account_id: null, amount_min: null, amount_max: null, category_id: categoryId, goal_id: null, goal_line_id: null, source: "manual", locked_at: null, active: 1, created_at: now });
    rulesSeeded++;
  }

  // 4. Debts (APRs are estimates — see file header).
  const debts = parseAssetsSheet(assets);
  const insertDebt = db.prepare(
    `INSERT OR REPLACE INTO debts (debt_id, person_id, account_id, name, kind, original_principal, current_balance, apr, min_payment, payment_day, maturity_date, status, created_at)
     VALUES (@id, 'nick', NULL, @label, @kind, NULL, @balance, @apr, @minPayment, NULL, NULL, 'active', @now)`,
  );
  for (const d of debts) insertDebt.run({ ...d, now });

  // 5. Goals from Upcomming Expenses: wedding (event, line items), Greece (trip), XREAL (purchase).
  const items = parseUpcomingSheet(upcoming);
  const weddingItems = items.filter((i) => i.label.toLowerCase().includes("wedding"));
  const greeceItems = items.filter((i) => i.label.toLowerCase().includes("greece"));
  const otherItems = items.filter((i) => !weddingItems.includes(i) && !greeceItems.includes(i));

  const insertGoal = db.prepare(
    `INSERT OR REPLACE INTO goals (goal_id, goal_type, name, person_id, target_amount, target_date, priority, funded_amount, status, created_at, notes)
     VALUES (@id, @type, @name, NULL, @target, NULL, @priority, 0, 'active', @now, @notes)`,
  );
  const insertLineItem = db.prepare(
    `INSERT OR REPLACE INTO goal_line_items (line_id, goal_id, name, amount, due_date, status) VALUES (@lineId, @goalId, @name, @amount, NULL, 'planned')`,
  );
  const seedGoal = (id: string, type: string, name: string, priority: number, goalItems: UpcomingItem[]) => {
    if (goalItems.length === 0) return;
    const target = roundCents(goalItems.reduce((s, i) => s + i.amount, 0));
    insertGoal.run({ id, type, name, target, priority, now, notes: "Seeded from workbook Upcomming Expenses" });
    for (const i of goalItems) {
      insertLineItem.run({ lineId: `${id}-${slugify(i.label, usedSlugs)}`, goalId: id, name: i.label, amount: i.amount });
    }
  };
  seedGoal("goal-wedding", "event", "Wedding", 1, weddingItems);
  seedGoal("goal-greece", "trip", "Greece trip", 2, greeceItems);
  for (const item of otherItems) {
    seedGoal(`goal-${slugify(item.label, usedSlugs)}`, "purchase", item.label, 3, [item]);
  }

  // 6. Recurring payments: whitelisted essentials bills + every subscription line.
  const insertRp = db.prepare(
    `INSERT OR REPLACE INTO recurring_payments (rp_id, name, category_id, person_id, account_id, expected_amount, amount_tolerance, currency, frequency, interval_days, anchor_date, next_due_date, end_date, autopay, reimbursed_by, debt_id, source, status, created_at)
     VALUES (@rpId, @name, @categoryId, @personId, NULL, @amount, 0.05, 'CAD', 'monthly', NULL, @anchor, @nextDue, NULL, 1, @reimbursedBy, @debtId, 'manual', 'active', @now)`,
  );
  let recurringSeeded = 0;
  for (const line of lines) {
    const wants = line.section.recurring;
    if (wants === "none") continue;
    if (wants !== "all" && !wants.includes(line.label)) continue;
    const reimbursedBy = line.note === "Work Pays" ? "work" : line.note === "Buildings Pay" ? "buildings" : null;
    const debtId = line.label === "Loan Repayment" ? "debt-student-loan" : null;
    // Strictly-after semantics would skip a bill due today — anchor on yesterday.
    const nextDue = nextOccurrence("monthly", ANCHOR, addDays(today, -1)) ?? ANCHOR;
    for (const [personId, amount] of [["shanthi", line.shanthi], ["nick", line.nick]] as const) {
      if (amount <= 0) continue;
      insertRp.run({
        rpId: `seed-${personId}-${childId.get(line)!}`,
        name: line.label,
        categoryId: childId.get(line)!,
        personId,
        amount,
        anchor: ANCHOR,
        nextDue,
        reimbursedBy,
        debtId,
        now,
      });
      recurringSeeded++;
    }
  }

  console.log(`Seeded: ${SECTIONS.length} category groups + ${lines.length} child categories`);
  console.log(`        ${budgetLines.length} budget lines (June 2026 baseline)`);
  console.log(`        ${rulesSeeded} category rules, ${debts.length} debts, ${recurringSeeded} recurring payments`);
  console.log(`        goals: wedding (${weddingItems.length} items), greece (${greeceItems.length}), ${otherItems.length} purchase(s)`);
  console.log(`NOTE: debt APRs are estimates (CC 20.99%, student loan 5.95%, LOC 7.20%) — update once statements are checked.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
