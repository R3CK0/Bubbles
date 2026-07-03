/**
 * engine/aiSuggestionService.ts — the Gemini-backed expense-review assistant
 * (Budget → Inbox → "AI review"). Reviews unclassified transactions one at a
 * time and proposes a target: a budget category (ideally a subcategory) or a
 * goal (ideally one of its line items). Accepting a suggestion writes the
 * classification AND a locked merchant→target mapping so every future charge
 * from that merchant lands the same way — except airlines and travel-booking
 * platforms, which are never locked: a flight or hotel can belong to any trip
 * goal, so the user decides each time.
 *
 * Built on Google ADK (@google/adk): a single-turn LlmAgent with a zod output
 * schema, run ephemerally per transaction. The key comes from GEMINI_API_KEY
 * in .env; without it the whole feature reports disabled and the inbox falls
 * back to history-based suggestions.
 */
import { z } from "zod";
import { Gemini, InMemoryRunner, LlmAgent } from "@google/adk";
import { Type, type Schema } from "@google/genai";
import { config } from "../config.js";
import { signedFlow, type FlowTx } from "../analytics/index.js";
import {
  getFlowTx,
  listCategories,
  setTransactionFlags,
  uncategorizedCount,
  listUncategorized,
} from "../db/repositories/budgeting.js";
import { listGoals, listLineItems } from "../db/repositories/planning.js";
import { categorizeManually, saveRule } from "./categorizationService.js";
import type { AiApplyBody } from "../server/contracts.js";
import { RateLimiter, withRetry } from "../util/retry.js";

export function isAiEnabled(): boolean {
  return config.gemini.apiKey.length > 0;
}

/**
 * Airlines + hotel/travel-booking platforms: a charge from these can belong
 * to any trip goal or to general travel spending, so mappings are never
 * locked and the assistant must ask every time. Checked server-side too —
 * the model flags them, but the lock refusal cannot depend on the model.
 */
const ALWAYS_ASK_PATTERNS: RegExp[] = [
  /air ?canada/i, /westjet/i, /air ?transat/i, /porter air/i, /flair air/i,
  /sunwing/i, /united air/i, /delta air/i, /american air/i, /lufthansa/i,
  /british air/i, /air france/i, /klm/i, /ana\b/i, /japan air/i, /jal\b/i,
  /\bairlines?\b/i, /\bairways\b/i,
  /expedia/i, /booking\.?com/i, /hotels\.?com/i, /airbnb/i, /vrbo/i,
  /trip\.?com/i, /priceline/i, /kayak/i, /travelocity/i, /hotwire/i,
  /agoda/i, /marriott/i, /hilton/i, /hyatt/i, /\bhotels?\b/i, /\bmotel\b/i,
];

export function isAlwaysAskMerchant(name: string | null | undefined): boolean {
  if (!name) return false;
  return ALWAYS_ASK_PATTERNS.some((p) => p.test(name));
}

/** What the model must return for each transaction. */
const suggestionSchema = z.object({
  target: z.enum(["budget", "goal", "unknown"])
    .describe("budget = a category below; goal = one of the active goals; unknown = no confident match"),
  categoryId: z.string().nullable()
    .describe("when target=budget: the category_id, preferring the most specific subcategory"),
  goalId: z.string().nullable().describe("when target=goal: the goal_id"),
  goalLineId: z.string().nullable()
    .describe("when target=goal: the line_id of the goal subcategory that fits (or null)"),
  confidence: z.number().min(0).max(1).describe("how sure you are, 0..1"),
  reason: z.string().describe("one short sentence explaining the match, user-facing"),
  alwaysAsk: z.boolean()
    .describe("true when the merchant is an airline or hotel/travel booking platform — never lock these"),
  newSubcategoryName: z.string().nullable()
    .describe("if no existing subcategory fits but one obviously should exist (e.g. 'Car insurance' under Insurance), its name"),
  newSubcategoryParentId: z.string().nullable()
    .describe("the parent category_id for newSubcategoryName"),
});
export type AiSuggestion = z.infer<typeof suggestionSchema>;

/**
 * The same schema as a raw Gemini Schema for the ADK agent: the app's zod
 * instance differs from the one ADK bundles, so passing the zod object
 * directly trips instance checks — the plain Schema form is version-proof.
 * Descriptions mirror suggestionSchema; keep the two in sync.
 */
const RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    target: {
      type: Type.STRING,
      enum: ["budget", "goal", "unknown"],
      description: "budget = a category below; goal = one of the active goals; unknown = no confident match",
    },
    categoryId: { type: Type.STRING, nullable: true, description: "when target=budget: the category_id, preferring the most specific subcategory" },
    goalId: { type: Type.STRING, nullable: true, description: "when target=goal: the goal_id" },
    goalLineId: { type: Type.STRING, nullable: true, description: "when target=goal: the line_id of the goal subcategory that fits (or null)" },
    confidence: { type: Type.NUMBER, description: "how sure you are, 0..1" },
    reason: { type: Type.STRING, description: "one short sentence explaining the match, user-facing" },
    alwaysAsk: { type: Type.BOOLEAN, description: "true when the merchant is an airline or hotel/travel booking platform — never lock these" },
    newSubcategoryName: { type: Type.STRING, nullable: true, description: "if no existing subcategory fits but one obviously should exist, its name" },
    newSubcategoryParentId: { type: Type.STRING, nullable: true, description: "the parent category_id for newSubcategoryName" },
  },
  required: ["target", "categoryId", "goalId", "goalLineId", "confidence", "reason", "alwaysAsk", "newSubcategoryName", "newSubcategoryParentId"],
};

function catalog(): string {
  const cats = listCategories(false);
  const byParent = new Map<string | null, typeof cats>();
  for (const c of cats) {
    const list = byParent.get(c.parent_id) ?? [];
    list.push(c);
    byParent.set(c.parent_id, list);
  }
  const lines: string[] = ["BUDGET CATEGORIES (category_id — name):"];
  for (const top of byParent.get(null) ?? []) {
    lines.push(`- ${top.category_id} — ${top.name} [${top.kind}]`);
    for (const sub of byParent.get(top.category_id) ?? []) {
      lines.push(`  - ${sub.category_id} — ${sub.name} (subcategory of ${top.name})`);
    }
  }
  lines.push("", "ACTIVE GOALS (goal_id — name, with subcategories as line_id — name):");
  for (const g of listGoals("active")) {
    lines.push(`- ${g.goal_id} — ${g.name} (${g.goal_type.replace(/_/g, " ")})`);
    for (const li of listLineItems(g.goal_id)) {
      if (li.status !== "cancelled") lines.push(`  - ${li.line_id} — ${li.name}`);
    }
  }
  return lines.join("\n");
}

function buildInstruction(): string {
  return `You are the expense-mapping assistant of a household finance app for a couple in Québec, Canada (CAD).
You are shown ONE unclassified bank transaction at a time (merchant/payee name, amount, date, and Plaid's machine categorization). Decide where it belongs:
- target "budget": pick the single best category_id from the catalog below, ALWAYS preferring the most specific subcategory over its parent (e.g. "Car insurance" over "Insurance").
- target "goal": when the spend clearly belongs to one of the active goals (trip bookings, wedding vendors, etc.), pick the goal_id, and the goal's line_id subcategory when one fits (e.g. a restaurant in Tokyo during the Japan trip → goal Japan trip, line item Food).
- target "unknown": when you cannot make a confident call. Never guess wildly.

Ground rules:
1. Use the merchant name AND Plaid's category as evidence. Plaid is often right about the domain (groceries, gas) but knows nothing about this household's goals.
2. Your suggestion, once accepted by the user, becomes a LOCKED mapping applied automatically to every future transaction from this merchant. So only be confident when the merchant→target relationship is stable over time (a grocery store is always groceries).
3. CRITICAL EXCEPTION — airlines and travel-booking platforms (Air Canada, WestJet, Air Transat, Porter, United, and any airline; Expedia, Booking.com, Hotels.com, Airbnb, VRBO, Trip.com, Priceline, hotel chains, and any hotel/travel booking company): the same merchant can serve ANY trip goal or ordinary travel, so a permanent mapping is wrong by construction. For these, set alwaysAsk=true — the app will ask the user where to put it EVERY time and will refuse to lock the mapping. Still propose your best one-time guess for THIS transaction (e.g. an Air Canada charge while a "Japan trip" goal is active is probably its Tickets line item).
4. If a transaction obviously fits a top-level category but none of its subcategories, and an evident subcategory is missing (e.g. "Promutuel" fits Insurance but there is no "Home insurance"), fill newSubcategoryName + newSubcategoryParentId so the app can offer to create it. Otherwise leave both null.
5. Deposits (direction "money in") that are earnings — payroll, rent collected, interest, dividends — belong in an [income]-kind category. A deposit that reverses a purchase (refund) belongs in the expense category of the original purchase instead.
6. reason must be one short, plain sentence the user reads on a card.

${catalog()}`;
}

function txPrompt(tx: FlowTx): string {
  return JSON.stringify({
    merchant: tx.merchantName,
    payee: tx.payee,
    amountCAD: Math.abs(signedFlow(tx)),
    direction: signedFlow(tx) < 0 ? "money out" : "money in",
    date: tx.date,
    plaidCategoryPrimary: tx.plaidPrimary,
    plaidCategoryDetailed: tx.plaidDetailed,
  });
}

function extractJson(text: string): unknown {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  return JSON.parse(cleaned);
}

/**
 * Rate limiting + retries around the Gemini call.
 *
 * Throttle: gemini-3.5-flash free tier is 10 RPM / 250K TPM / 1,500 RPD;
 * a serializing limiter keeps request starts >= 60s/GEMINI_RPM apart (default
 * 8 RPM), so even the auto-review loop can't burst past the quota.
 *
 * Retries: 429 RESOURCE_EXHAUSTED, 5xx, model-overloaded and network errors
 * back off exponentially with jitter; a delay mandated by Google's RetryInfo
 * ("retryDelay":"22s") is honored when present. Auth/permission errors
 * (400/401/403 — e.g. a bad key) fail immediately.
 */
const geminiLimiter = new RateLimiter(Math.ceil(60_000 / config.gemini.rpm));

const GEMINI_RETRYABLE =
  /RESOURCE_EXHAUSTED|rate.?limit|quota|overloaded|UNAVAILABLE|DEADLINE_EXCEEDED|INTERNAL|\b(429|500|502|503|504)\b|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up/i;
const GEMINI_FATAL = /API key not valid|API_KEY_INVALID|PERMISSION_DENIED|\b(400|401|403)\b/i;

function isRetryableGeminiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (GEMINI_FATAL.test(msg)) return false;
  // A malformed/empty model reply is worth one more roll of the dice too.
  return GEMINI_RETRYABLE.test(msg) || err instanceof SyntaxError;
}

/** Google embeds RetryInfo in the error text: ..."retryDelay":"22s"... */
function mandatedDelayMs(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /retryDelay["':\s]+(\d+(?:\.\d+)?)s/i.exec(msg);
  return m ? Math.ceil(Number(m[1]) * 1000) : null;
}

async function runGeminiOnce(tx: FlowTx): Promise<AiSuggestion> {
  const agent = new LlmAgent({
    name: "expense_mapper",
    description: "Maps one bank transaction to a budget category or goal.",
    model: new Gemini({ model: config.gemini.model, apiKey: config.gemini.apiKey }),
    instruction: buildInstruction(),
    outputSchema: RESPONSE_SCHEMA,
    generateContentConfig: { temperature: 0 },
  });
  const runner = new InMemoryRunner({ agent, appName: "finances-ai-review" });

  let finalText = "";
  let errorMessage: string | null = null;
  for await (const event of runner.runEphemeral({
    userId: "household",
    newMessage: { role: "user", parts: [{ text: txPrompt(tx) }] },
  })) {
    if (event.errorMessage) errorMessage = `${event.errorCode ?? "error"}: ${event.errorMessage}`;
    const text = event.content?.parts?.map((p) => p.text ?? "").join("");
    if (text && !event.partial) finalText = text;
  }
  if (!finalText) {
    throw Object.assign(
      new Error(`Gemini returned no suggestion${errorMessage ? ` — ${errorMessage}` : ""}`),
      { status: 502 },
    );
  }
  return suggestionSchema.parse(extractJson(finalText));
}

/** One ephemeral single-turn agent run per transaction — throttled + retried. */
export async function suggestForTransaction(tx: FlowTx): Promise<AiSuggestion> {
  if (!isAiEnabled()) {
    throw Object.assign(new Error("GEMINI_API_KEY is not configured"), { status: 503 });
  }
  const suggestion = await withRetry(() => geminiLimiter.run(() => runGeminiOnce(tx)), {
    attempts: 4,
    baseDelayMs: 2000,
    maxDelayMs: 45_000,
    shouldRetry: isRetryableGeminiError,
    retryDelayMs: mandatedDelayMs,
    onRetry: (err, attempt, delay) =>
      console.warn(
        `[ai] gemini attempt ${attempt} failed (retrying in ${Math.round(delay / 1000)}s):`,
        err instanceof Error ? err.message : err,
      ),
  });
  return sanitize(tx, suggestion);
}

/** Trust nothing blindly: verify ids exist and re-derive alwaysAsk locally. */
function sanitize(tx: FlowTx, s: AiSuggestion): AiSuggestion {
  const out = { ...s };
  out.alwaysAsk = s.alwaysAsk || isAlwaysAskMerchant(tx.merchantName ?? tx.payee);

  const cats = new Map(listCategories(true).map((c) => [c.category_id, c]));
  if (out.categoryId && !cats.has(out.categoryId)) out.categoryId = null;
  if (out.newSubcategoryParentId && !cats.has(out.newSubcategoryParentId)) {
    out.newSubcategoryName = null;
    out.newSubcategoryParentId = null;
  }
  if (out.goalId) {
    const goal = listGoals("active").find((g) => g.goal_id === out.goalId);
    if (!goal) {
      out.goalId = null;
      out.goalLineId = null;
    } else if (out.goalLineId && !listLineItems(goal.goal_id).some((li) => li.line_id === out.goalLineId)) {
      out.goalLineId = null;
    }
  }
  if (out.target === "budget" && !out.categoryId) out.target = "unknown";
  if (out.target === "goal" && !out.goalId) out.target = "unknown";
  return out;
}

export interface AiReviewCard {
  transaction: {
    transactionId: string;
    date: string;
    merchant: string | null;
    amount: number;
    plaidPrimary: string | null;
    plaidDetailed: string | null;
  };
  suggestion: AiSuggestion;
  /** Whether accepting will lock the mapping (false for airlines/booking). */
  willLock: boolean;
  remaining: number;
}

/** Review the next unclassified expense (or a specific one) with Gemini. */
export async function reviewNext(transactionId?: string): Promise<AiReviewCard | { done: true }> {
  const tx = transactionId ? getFlowTx(transactionId) : listUncategorized(1)[0];
  if (!tx) return { done: true };
  const suggestion = await suggestForTransaction(tx);
  return {
    transaction: {
      transactionId: tx.transactionId,
      date: tx.date,
      merchant: tx.merchantName ?? tx.payee,
      amount: signedFlow(tx), // positive = money in, matching the inbox card
      plaidPrimary: tx.plaidPrimary,
      plaidDetailed: tx.plaidDetailed,
    },
    suggestion,
    willLock: !suggestion.alwaysAsk,
    remaining: uncategorizedCount(),
  };
}

export interface AiApplyResult {
  applied: boolean;
  locked: boolean;
  lockedReason: string | null;
}

/**
 * Apply a (possibly user-overridden) suggestion: classify the transaction,
 * then lock the merchant→target mapping for future transactions — unless the
 * merchant is on the airline/booking always-ask list, which is enforced here
 * regardless of what the client sent.
 */
export function applySuggestion(body: AiApplyBody): AiApplyResult {
  const tx = getFlowTx(body.transactionId);
  if (!tx) {
    throw Object.assign(new Error("transaction not found"), { status: 404 });
  }

  let applied: boolean;
  if (body.target === "budget") {
    // user confirmed → manual source, wins over any rule forever
    applied = categorizeManually(body.transactionId, body.categoryId!);
  } else {
    applied = setTransactionFlags(body.transactionId, {
      goalId: body.goalId!,
      goalLineId: body.goalLineId ?? null,
    });
  }

  const pattern = body.merchantPattern ?? tx.merchantName ?? tx.payee;
  if (!body.lock || !pattern) {
    return { applied, locked: false, lockedReason: body.lock ? "no merchant name to match on" : null };
  }
  if (isAlwaysAskMerchant(pattern)) {
    return {
      applied,
      locked: false,
      lockedReason: "airline / travel-booking merchant — you'll be asked every time",
    };
  }
  saveRule(
    {
      priority: 50,
      merchantPattern: pattern,
      categoryId: body.target === "budget" ? body.categoryId : null,
      goalId: body.target === "goal" ? body.goalId : null,
      goalLineId: body.target === "goal" ? (body.goalLineId ?? null) : null,
      source: "ai",
      lock: true,
    },
    0,
  );
  return { applied, locked: true, lockedReason: null };
}
