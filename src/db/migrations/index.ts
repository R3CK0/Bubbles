import { migration as m001 } from "./001_init.js";
import { migration as m002 } from "./002_persons_settings.js";
import { migration as m003 } from "./003_extend_banking.js";
import { migration as m004 } from "./004_categories_budgets.js";
import { migration as m005 } from "./005_history.js";
import { migration as m006 } from "./006_recurring_debts.js";
import { migration as m007 } from "./007_goals_plans.js";
import { migration as m008 } from "./008_investments.js";
import { migration as m009 } from "./009_tax.js";
import { migration as m010 } from "./010_ops.js";
import { migration as m011 } from "./011_account_classification.js";
import { migration as m012 } from "./012_manual_positions.js";
import { migration as m013 } from "./013_weekly_take_home.js";
import { migration as m014 } from "./014_goal_tagged_transactions.js";
import { migration as m015 } from "./015_mapping_rules.js";
import { migration as m016 } from "./016_debt_statements.js";
import { migration as m017 } from "./017_goal_categories.js";
import { migration as m018 } from "./018_item_sync_error.js";

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

// Order matters: later migrations ALTER/reference tables created earlier.
export const MIGRATIONS: Migration[] = [
  m001,
  m002,
  m003,
  m004,
  m005,
  m006,
  m007,
  m008,
  m009,
  m010,
  m011,
  m012,
  m013,
  m014,
  m015,
  m016,
  m017,
  m018,
];
