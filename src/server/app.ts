import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { Express } from "express";
import { Vault } from "../vault/vault.js";
import { healthRouter } from "./routes/health.js";
import { vaultStatusRouter } from "./routes/vaultStatus.js";
import { linkRouter } from "./routes/link.js";
import { itemsRouter } from "./routes/items.js";
import { accountsRouter } from "./routes/accounts.js";
import { syncRouter } from "./routes/sync.js";
import { transactionsRouter } from "./routes/transactions.js";
import { balancesRouter } from "./routes/balances.js";
import { personsRouter } from "./routes/persons.js";
import { cashflowRouter } from "./routes/cashflow.js";
import { budgetRouter } from "./routes/budget.js";
import { aiRouter } from "./routes/ai.js";
import { billsRouter } from "./routes/bills.js";
import { debtsRouter } from "./routes/debts.js";
import { networthRouter } from "./routes/networth.js";
import { portfolioRouter } from "./routes/portfolio.js";
import { goalsRouter } from "./routes/goals.js";
import { taxRouter } from "./routes/tax.js";
import { opsRouter } from "./routes/ops.js";
import { errorHandler } from "./middleware/errorHandler.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "..", "public");

export function createApp(vault: Vault | null): Express {
  const app = express();
  app.locals.vault = vault ?? undefined;

  app.use(express.json());
  app.use(express.static(publicDir));

  app.use(healthRouter);
  app.use(vaultStatusRouter);
  // Engine routes read only the local DB — mounted BEFORE the vault-guarded
  // Plaid routers (whose router-level vaultGuard would otherwise 503 every
  // request), so the dashboard keeps working when a session grant expires.
  app.use(personsRouter);
  app.use(cashflowRouter);
  app.use(budgetRouter);
  app.use(aiRouter);
  app.use(billsRouter);
  app.use(debtsRouter);
  app.use(networthRouter);
  app.use(portfolioRouter);
  app.use(goalsRouter);
  app.use(taxRouter);
  app.use(opsRouter);
  // SPA fallback for the web app (built into public/): every non-API GET
  // serves index.html so deep links like /goals survive a refresh. Mounted
  // BEFORE the vault-guarded routers — their router-level vaultGuard runs on
  // every path entering them and would 503 page URLs while locked.
  app.get(/^\/(?!api\/|healthz).*/, (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });
  app.use(linkRouter);
  app.use(itemsRouter);
  app.use(accountsRouter);
  app.use(syncRouter);
  app.use(transactionsRouter);
  app.use(balancesRouter);

  app.use(errorHandler);

  return app;
}
