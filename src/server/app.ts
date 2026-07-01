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
  app.use(linkRouter);
  app.use(itemsRouter);
  app.use(accountsRouter);
  app.use(syncRouter);
  app.use(transactionsRouter);
  app.use(balancesRouter);

  app.use(errorHandler);

  return app;
}
