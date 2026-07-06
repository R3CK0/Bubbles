import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");

// Minimal .env loader (no dependency): real environment always wins, so
// docker-compose / shell exports keep working unchanged. Loaded before the
// config object below reads process.env.
const envPath = path.join(projectRoot, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    const key = m[1]!;
    const raw = m[2] ?? "";
    if (process.env[key] === undefined) {
      process.env[key] = raw.replace(/^(["'])(.*)\1$/, "$2");
    }
  }
}

const dataDir = process.env.FINANCES_DATA_DIR
  ? path.resolve(process.env.FINANCES_DATA_DIR)
  : path.join(projectRoot, "data");

const vaultDir = path.join(dataDir, "vault");

export const config = {
  port: Number(process.env.PORT ?? 4000),
  dataDir,
  vaultDir,
  dbPath: path.join(dataDir, "finances.db"),
  vault: {
    identityPath: path.join(vaultDir, "identity.txt"),
    recipientPath: path.join(vaultDir, "recipient.txt"),
    secretsPath: path.join(vaultDir, "secrets.age"),
    sessionKeyServiceName: "finances-vault-session",
    sessionKeyAccount: "session-key",
    sessionMetaPath: path.join(vaultDir, "session.json"),
    sessionSecretsPath: path.join(vaultDir, "session.secrets.enc"),
    sessionKeyFallbackPath: path.join(vaultDir, "session.key"),
  },
  session: {
    maxDays: 30,
    defaultDays: 30,
  },
  plaid: {
    defaultCountryCodes: (process.env.PLAID_COUNTRY_CODES ?? "CA").split(","),
    defaultLanguage: process.env.PLAID_LANGUAGE ?? "en",
    products: (process.env.PLAID_PRODUCTS ?? "transactions").split(","),
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY ?? "",
    model: process.env.GEMINI_MODEL ?? "gemini-3.5-flash",
    /**
     * Client-side requests-per-minute throttle. The gemini-3.5-flash FREE
     * tier allows 10 RPM / 1,500 RPD — default 8 stays safely under it.
     * On a paid tier (150+ RPM) raise GEMINI_RPM accordingly.
     */
    rpm: Math.max(1, Number(process.env.GEMINI_RPM ?? 8)),
  },
  /**
   * Telegram push notifications for background failures (e.g. a bank sync
   * error). The bot token only lets someone message through this bot, not
   * read finances, so it lives in .env alongside the Gemini key. The feature
   * is disabled unless BOTH the token and the chat id are set.
   */
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    chatId: process.env.TELEGRAM_CHAT_ID ?? "",
  },
  /**
   * Live market data. Yahoo Finance is the keyless primary (search + intraday
   * quotes + daily closes + option chains); Finnhub is an optional fallback
   * used only when Yahoo errors — set FINNHUB_API_KEY (free tier, 60 req/min)
   * to enable it. The intraday job refreshes every FINANCES_INTRADAY_MINUTES
   * during market hours; set it to 0 to disable intraday refresh entirely.
   */
  marketData: {
    finnhubApiKey: process.env.FINNHUB_API_KEY ?? "",
    intradayMinutes: Math.max(0, Number(process.env.FINANCES_INTRADAY_MINUTES ?? 5)),
  },
} as const;
