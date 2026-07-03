import { useMemo, useState } from "react";
import { Card } from "../components/ui";

interface QA { q: string; a: string }
interface Section { title: string; icon: string; intro?: string; items: QA[] }

const FAQ: Section[] = [
  {
    title: "Getting started & the shell",
    icon: "🫧",
    intro: "Controls that follow you across every page.",
    items: [
      { q: "What do the Both / Nick / Shanthi buttons do?", a: "That's the person lens. Every figure on every page is recomputed for the selected member — their accounts plus anything joint. 'Both' shows the combined household. The server does the math, so the numbers are always consistent. Keyboard: [ and ] cycle the lens." },
      { q: "What does the month control change?", a: "The analysis window. Budget, cash flow, bills, and the tax proposal all follow it, so you can scrub back and see any past month exactly as it was. Keyboard: , and . step months; click the month to open a 12-month strip." },
      { q: "What does the sync dot mean?", a: "Green and breathing: the last successful sync was under 24 hours ago. Amber: stale. Gray: the bank vault is locked. Hover it for the exact timestamp." },
      { q: "Why do I see a 'Bank connection locked' banner?", a: "Plaid credentials live in a YubiKey-encrypted vault. When the server process has no unlocked copy, syncing and linking are disabled — but every dashboard keeps working from the local database. Fix: on the host, run `npm run vault -- grant-session` (one YubiKey touch; add --portable if the server runs in Docker). The running server checks for the grant automatically and unlocks within a minute — no restart." },
      { q: "Can I re-run the setup wizard?", a: "Yes — Settings → 'Re-run setup wizard'. It's the same seven steps: household, income, budget, connect, recurring, goals, then history pull + reconciliation." },
    ],
  },
  {
    title: "Overview",
    icon: "🏠",
    intro: "The five-second answer to 'how are we doing?'.",
    items: [
      { q: "Where does the net-worth number come from?", a: "Tracked account balances plus manual assets (like Buildings) minus debts, snapshotted daily by the nightly job. The sparkline is the last 90 days; a gold flag marks a record high." },
      { q: "What are Money in / Money out / Net?", a: "This month's categorized transactions through the person lens. Transfers between your own accounts, work-reimbursed rows, and goal-tagged spending are excluded, so these are true household figures." },
      { q: "What do the goal ring colors mean?", a: "The ring fill is progress (funded ÷ target). The color is the affordability solver's verdict for the goal's target date: green = on track, amber = tight, red = not feasible at current free cash flow." },
      { q: "Why does a bill dot pulse amber in 'Next 7 days'?", a: "The projected account balance dips below your buffer floor on that day. The Bills page shows the full projection ribbon." },
    ],
  },
  {
    title: "Cash Flow",
    icon: "💸",
    intro: "Where the money actually went.",
    items: [
      { q: "What feeds the Money in / Money out pies?", a: "Income sources (each person's pay, named streams like Buildings) and top-level spending categories for the selected month. Click a spending row to open the drill-down drawer with every transaction, a 6-month trend, and variance drivers." },
      { q: "How is the savings rate computed?", a: "Net (income − spend) ÷ income for the month. It uses after-exclusion figures, so reimbursements don't inflate it." },
      { q: "How do I read the flux matrix?", a: "Twelve months × category. In 'vs Budget' mode each cell is actual minus your current budget line — green under, amber over. 'Actuals' mode shows raw spend. Click any cell for the drill-down." },
      { q: "What are variance drivers?", a: "The engine decomposes a category's overspend into causes: a new merchant, a price increase on a known one, higher frequency, or a one-off. They appear in the drawer and in the Budget row narratives." },
    ],
  },
  {
    title: "Budget",
    icon: "📊",
    intro: "Versioned, after-tax, and honest about exclusions.",
    items: [
      { q: "Why is the budget 'after tax'?", a: "The income line comes from what actually lands in your accounts — your weekly take-home (plus extra income net of tax), not gross salary. So 'left to budget' is money that exists." },
      { q: "What does the bar and the ▲/▼ chip on each row mean?", a: "The bar is actual spend against the budget line (amber when over). The chip is the variance: ▲ over budget, ▼ under. Expand a row for subcategories, a 6-month trend, the variance narrative, and a slider to change the line." },
      { q: "What happens when I change a budget amount?", a: "Budgets are versioned: the change creates/extends a version effective from the current month. Past months keep the budget they had — the History button lists versions." },
      { q: "What is 'pace'?", a: "Actual ÷ (budget × fraction of the month elapsed). Pacing above 100% mid-month means you'll overshoot by month-end at the current rate." },
      { q: "What is the 'Not counted in this budget' card?", a: "Everything the budget deliberately ignores this month: work-reimbursed expenses (with how much has been repaid so far), buildings-covered costs, and spending tagged to goals. Nothing is hidden — it's just not household spending." },
      { q: "How does the inbox work?", a: "Uncategorized transactions arrive as a card stack. Number keys pick a category; 'always do this' turns the pick into a rule that also re-tags the last 12 months. The 'Not household spending?' row flags a transaction as work-reimbursed or as goal spending instead." },
      { q: "My employer reimburses an expense — how do I keep it out of the budget?", a: "Flag BOTH sides: the expense and the repayment deposit ('💼 Work reimburses' in the inbox). The expense leaves spending and the deposit leaves income, so reimbursement weeks don't look like raises. For recurring cases, set 'Covered by: Work' on the bill — matched payments are flagged automatically." },
    ],
  },
  {
    title: "Bills & recurring",
    icon: "📅",
    intro: "What repeats, when, and whether the balance survives it.",
    items: [
      { q: "What is the projected balance ribbon?", a: "Expected balance across the month: start balance, minus each upcoming bill on its due date, plus payday bumps. Days where it dips below your buffer floor glow amber on the calendar and shade the chart." },
      { q: "What is the buffer floor?", a: "The cash cushion you never want to breach (set in Settings or onboarding). The ribbon warns against it; the goal solver protects a separate, larger buffer target before funding goals." },
      { q: "Where do 'Detected in your transactions' bills come from?", a: "The nightly job looks for repeating charges in your history (same merchant, similar amount, regular cadence). Accept to track one; dismiss to never see it again. During onboarding these are reconciled against the bills you typed in." },
      { q: "What is the price-creep badge?", a: "The bill's charged amount has drifted up since first seen — the sparkline shows its price history. Classic subscription inflation detector." },
      { q: "What does 'Covered by: Work / Buildings' do?", a: "The bill stays in the registry and calendar (it still hits your account), but its matched transactions are excluded from the budget and cash flow — someone else ultimately pays it." },
    ],
  },
  {
    title: "Goals & planning",
    icon: "🎯",
    intro: "Drag a goal, watch the plan recompute.",
    items: [
      { q: "How does drag-to-replan work?", a: "Drag a goal bar's length on the timeline to move its target date. The affordability solver re-runs live: feasibility chips, required-monthly figures, and red collision months (where demands exceed free cash flow) update as you drag. 'Save as plan' commits it." },
      { q: "What do ✓ / ~ / ✕ verdicts mean?", a: "The solver allocates your monthly free cash flow across the buffer, debts, and goals by priority. Green: fully funded by the target date. Amber: funded but with no slack. Red: can't be funded in time — the chip shows the gap." },
      { q: "What is 'required monthly'?", a: "What you'd need to put aside every month from now to hit the target amount by the target date, given what's already funded." },
      { q: "How do goal budgets work?", a: "A goal's target doubles as its spending envelope. Tag transactions to the goal from the Budget inbox and they leave the household budget, accumulating under 'spent against this goal' instead. Event goals (weddings) can also itemize line items with statuses." },
      { q: "What are scenarios?", a: "Saved what-if worlds (e.g. 'Shanthi part-time, −$800/mo'). Click one to solve it side-by-side against today's plan and compare per-goal verdicts and funding dates." },
    ],
  },
  {
    title: "Debt",
    icon: "📉",
    intro: "The mountain melts — pick how fast.",
    items: [
      { q: "Avalanche vs snowball?", a: "Avalanche pays the highest APR first (mathematically cheapest); snowball pays the smallest balance first (quickest wins). The toggle morphs the projection between them and the chip quantifies the difference in months and interest." },
      { q: "What does the extra-payment slider do?", a: "Adds that much per month on top of all minimum payments and re-projects the payoff. Watch the debt-free date and total interest respond." },
      { q: "Where do minimum payments come from?", a: "The value you set per debt, or an estimated floor for credit cards when unset. Keep APRs current — statement rates beat estimates." },
    ],
  },
  {
    title: "Investments",
    icon: "📈",
    intro: "You maintain the positions; the engine does the rest.",
    items: [
      { q: "Why do I enter positions manually?", a: "Plaid's investments product needs a production tier, so the portfolio is user-maintained: enter what each account holds (symbol + quantity, or a manual value for cash). 'Refresh prices' pulls Yahoo Finance daily closes and rebuilds history." },
      { q: "What is 'Contributions vs growth'?", a: "The honest chart: splits portfolio value into cumulative money you put in (gray) versus what the market did (green). A rising line means little if it's all contributions." },
      { q: "What does the 'vs bank' drift chip mean?", a: "Your entered positions × latest prices, compared to the balance the bank reports. A gap means a position is missing or stale." },
      { q: "How does allocation drift work?", a: "Outer ring = actual weights, inner ring = your targets. Segments off target by more than ~2% get an amber callout. Set targets from the allocation card." },
      { q: "What is the Buildings card?", a: "A manual asset with valuation history plus a mini P&L: rental income (its category) against buildings-reimbursed expenses, by month." },
    ],
  },
  {
    title: "Net Worth",
    icon: "🏦",
    intro: "Assets up, debts mirrored down, the net line through it.",
    items: [
      { q: "How do I read the mirrored chart?", a: "Assets fill above the axis, debts mirror below it, and the net line threads between. Hover any point for that day's full account-level breakdown in the side panel. Gold flags are record highs." },
      { q: "What is the emergency fund gauge?", a: "Liquid balances ÷ average monthly essentials = months of runway. Green at 3+ months against a 6-month target; the buffer settings live in Settings." },
      { q: "Why is my history short?", a: "Daily snapshots start accumulating when the nightly job first runs; Plaid backfills up to 24 months of transactions but balances are snapshotted going forward." },
    ],
  },
  {
    title: "Taxes",
    icon: "🧾",
    intro: "Québec + federal, deterministic, optimizer included.",
    items: [
      { q: "How is the estimate computed?", a: "A simplified federal + Québec (T1/TP-1) calculation from versioned bracket tables: your gross income runs through both jurisdictions' brackets, credits, and payroll (QPP, QPIP, EI). Set each person's income and withholding via 'edit income'." },
      { q: "What is the bracket glass?", a: "Your income filling each tax bracket like liquid — the top, partly-filled tier is your marginal rate made visible. The gauge needle is marginal; the small figure below is your average rate." },
      { q: "What are 'other paycheque deductions'?", a: "The gap between the brackets' predicted after-tax pay and your actual weekly deposits: group health insurance, pension, union dues — things no tax table knows. Entered take-home makes the budget run on real money." },
      { q: "How does the proposed plan work?", a: "Your budget surplus × months remaining = deployable cash. The optimizer fills FHSA first (deduct now, withdraw tax-free for a home), then RRSP against the highest marginal rate, then TFSA — respecting each person's contribution room. Drag the slider to test other amounts; 'Accept plan' turns it into monthly plan lines the Goals page respects." },
      { q: "Where does contribution room come from?", a: "You enter it from CRA My Account (Contribution room button); contributions detected in your accounts draw it down. The optimizer never exceeds remaining room." },
      { q: "What does the balance beam show?", a: "Estimated tax owed vs withheld so far: tilted red means owing at filing time, green means a refund is coming." },
    ],
  },
  {
    title: "Monthly review",
    icon: "📖",
    intro: "The money date, structured.",
    items: [
      { q: "What is story mode?", a: "A full-screen deck for reviewing the month together: what came in, where it went, variances worth discussing, goal progress, net worth, the month ahead. Advance with ← → or the buttons; cast it to a TV." },
      { q: "What is the decision log?", a: "Decisions typed on the final slide are stamped with the month and kept forever — 'we agreed to cap dining at $400'. They show at the start of the next review." },
      { q: "What does 'Finish & archive' do?", a: "Freezes the month's report. Archived reviews render instantly from the snapshot and never change, even if you recategorize history later." },
    ],
  },
  {
    title: "Accounts & sync",
    icon: "🔗",
    intro: "The front door: link, classify, sync.",
    items: [
      { q: "How does linking a bank work?", a: "Add bank → Plaid's secure overlay (credentials never touch Bubbles) → pick which accounts to track → classify each: whose it is, what it is (cash, savings, FHSA/TFSA/RRSP/RESP/non-registered, credit, loan), and an optional purpose tag. Credit/loan accounts can become tracked debts with an APR on the spot." },
      { q: "What are the meaning chips on an account?", a: "Owner · registered type · purpose. Click them to edit. They drive everything: the person lens, tax room tracking, and goal auto-linking (an account tagged 'House down payment' feeds that goal's ring)." },
      { q: "What's the difference between 'Sync now' and the nightly job?", a: "Sync pulls new transactions for one bank. The nightly pipeline does everything: sync, FX, snapshots, auto-categorize, recurring matching/detection, contribution detection, goal refresh, alerts. Run it manually from Settings." },
      { q: "What does unlinking delete?", a: "It revokes access at Plaid and deletes that bank's local accounts and transactions (you type the institution name to confirm). Re-linking restores whatever Plaid still has — typically up to 24 months." },
    ],
  },
  {
    title: "Data & privacy",
    icon: "🔒",
    intro: "Local-first by design.",
    items: [
      { q: "Where does my data live?", a: "In a SQLite file on your own machine (data/finances.db). Nothing is sent anywhere except Plaid API calls for syncing and Yahoo Finance for prices. There is no cloud account." },
      { q: "What does the YubiKey protect?", a: "The Plaid API credentials and bank access tokens, encrypted at rest with age + the YubiKey's PIV slot. A session grant (npm run vault -- grant-session) re-seals them under a temporary key — Keychain on macOS, a 0600 file with --portable for Docker — valid up to 30 days, so the server runs unattended. Without either, the server boots locked: dashboards work from local data, bank calls don't. `npm run vault -- status` shows remaining validity; `revoke-session` kills a grant instantly." },
      { q: "Are the analytics deterministic?", a: "Yes — every number is computed by pure, tested functions over your database (105 tests, including golden tax cases against published CRA/RQ examples). No AI guesses at your finances." },
    ],
  },
];

export function Help() {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  const sections = useMemo(() => {
    if (!query.trim()) return FAQ;
    const q = query.toLowerCase();
    return FAQ.map((s) => ({
      ...s,
      items: s.items.filter((it) => it.q.toLowerCase().includes(q) || it.a.toLowerCase().includes(q) || s.title.toLowerCase().includes(q)),
    })).filter((s) => s.items.length > 0);
  }, [query]);

  return (
    <div className="page col" style={{ gap: 16, maxWidth: 860 }}>
      <div className="spread" style={{ flexWrap: "wrap", gap: 12 }}>
        <div>
          <div className="h1">Help & FAQ</div>
          <div className="muted" style={{ fontSize: 12.5, marginTop: 3 }}>How each page works — hover the small ? dots around the app for the same explanations in place.</div>
        </div>
        <input className="input" style={{ width: 260 }} placeholder="Search the FAQ…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {sections.map((s) => (
        <Card key={s.title} style={{ padding: "8px 8px 10px" }}>
          <div style={{ padding: "12px 16px 4px" }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{s.icon} {s.title}</div>
            {s.intro && <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>{s.intro}</div>}
          </div>
          {s.items.map((it) => {
            const key = `${s.title}|${it.q}`;
            const isOpen = open === key || !!query.trim();
            return (
              <div key={it.q} className="hoverable" style={{ padding: "10px 16px", cursor: "pointer" }} onClick={() => setOpen(isOpen && !query.trim() ? null : key)}>
                <div className="spread">
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{it.q}</div>
                  <span className="muted" style={{ fontSize: 13, flex: "none", marginLeft: 10 }}>{isOpen ? "−" : "+"}</span>
                </div>
                {isOpen && <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.65, marginTop: 7, animation: "bb-rowin .18s ease-out" }}>{it.a}</div>}
              </div>
            );
          })}
        </Card>
      ))}
      {sections.length === 0 && <Card><div className="empty">No matches — try another word.</div></Card>}
    </div>
  );
}
