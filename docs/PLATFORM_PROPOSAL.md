# Household Finance & Wealth Platform — Proposal

*Draft v1 — July 2026. Local-first platform built on the existing Plaid + SQLite + YubiKey-vault backend.*

## 1. Vision

One private, local system that both partners can open from any device at home and
answer, at a glance:

1. **Where is our money going?** (and where are we over/under spending)
2. **What are we working toward?** (house, kids, wedding, trips, purchases) and
   **can we afford it, by when?**
3. **What's coming?** (bills, loan payments, renewals — no surprises)
4. **How is our wealth growing?** (investments, property, debts, net worth)

Everything is computed by deterministic, tested functions over the local
database. The AI agent layer (in-platform or via MCP) comes later and *calls*
those functions — it never invents numbers.

---

## 2. What the current budget workbook tells us (design inputs)

From `Joint_Finances_06-2026.xlsx`:

| Observation | Design consequence |
|---|---|
| Combined income ≈ $13.6k/mo, incl. $1k/mo rental ("Buildings") income | Income needs multiple streams per person, incl. property income |
| Categories: Essentials, Entertainment/Lifestyle/Work subscriptions, Vacation, Savings, Donations, Other | Category tree should be user-defined, seeded from this workbook |
| ~30+ subscriptions tracked line-by-line, some reimbursed ("Work Pays", "Buildings Pay") | Recurring-payment engine needs a *reimbursement/offset* concept and renewal tracking |
| Sinking funds already in use (Vacation $833/person/mo) | Goals engine should generalize the sinking-fund pattern |
| FHSA/TFSA/RRSP contributions tracked separately | Canadian registered-account awareness (contribution room, FHSA↔house goal link) |
| Debts: credit card ≈ $19.5k, student loan ≈ $27.6k, student LOC ≈ $53.4k | A debt module is not optional — high-interest payoff must be part of any savings plan the system produces |
| Investments ≈ $217k across Wealthsimple + RBC + a $130k property share | Portfolio tracking must handle brokerage accounts *and* manual/illiquid assets |
| Upcoming: wedding items, Greece trip | One-off planned expenses with dates — first-class objects, not spreadsheet rows |
| Everything split per-person with combined totals | Every view needs Person A / Person B / Joint lenses |
| Location: Québec, CAD (Bixi, Centraide, Blue Cross, FHSA) | `PLAID_COUNTRY_CODES=CA`, CAD base currency with USD support |

---

## 3. Feature brainstorm

Tagged **[R]** = requested, **[+]** = proposed addition we shouldn't forget.

### A. Cash flow & budgeting — *"where is our money going"*
- **[R]** Spending overview: monthly in/out by category, trend lines, per-person and combined.
- **[R]** Budget vs. actual with over/under-spend flags per category, month and rolling-3-month views (one bad month ≠ a trend).
- **[+]** Variance narratives: deterministic decomposition of *why* a category moved (new merchant, price increase, frequency increase).
- **[+]** Categorization rules engine: user-defined overrides on top of Plaid categories ("Costco → Groceries"), applied retroactively; uncategorized-transaction inbox to triage together.
- **[+]** The "Financial Flux" table from the workbook, automated: a 12-month actuals matrix per category, filled by the sync — no manual entry ever again.
- **[+]** Seasonality awareness (winter electricity, summer travel) so alerts don't cry wolf.
- **[+]** Reimbursement tracking: expenses marked "work pays" / "buildings pay" net out of personal spend.

### B. Recurring payments & bills — *"set payments in advance"*
- **[R]** Recurring payment registry: loans, car, rent, utilities, internet, cellphone, subscriptions — amount, cadence, payment account, next due date, end date (loans end!).
- **[+]** Auto-detection: mine synced transactions to *discover* recurring payments and propose them (catches the ones you forgot).
- **[+]** Bills calendar: month view of upcoming debits vs. paydays; projected account balance curve → **low-balance warnings before they happen**.
- **[+]** Price-creep alerts: "Netflix charged $29.99, was $27.59" — across all 30+ subscriptions this is real money.
- **[+]** Renewal & cancellation list: annual renewals surfaced 30 days ahead; "unused subscription" flag when no matching usage/charge pattern.
- **[+]** Loan amortization awareness: car and student loans get payoff dates and interest-vs-principal splits, not just a monthly line.

### C. Goals & planning — *"house, kids, trips, savings, large purchases"*
- **[R]** Goal types, each with tailored math:
  - **House** — down payment target linked to FHSA balances + first-home programs; mortgage affordability (Canadian stress test, GDS/TDS ratios) at current rates.
  - **Kids** — one-time costs + *recurring cost step-change* (childcare, RESP) + parental-leave income dip modeling (QPIP in Québec).
  - **Trips** — sinking funds with a date (generalizes the current Vacation line).
  - **Large purchases** — target amount + date (car, XREAL, furniture).
  - **Savings/investment targets** — emergency fund, FHSA/TFSA max-out, net-worth milestones.
  - **Events** — the wedding: a budget envelope with line items and a date.
- **[R]** **Affordability engine** (the core deterministic solver):
  - Input: goals with amounts/dates/priorities + current free cash flow + existing commitments.
  - Output: required monthly savings per goal, feasibility verdict, funding schedule, and — when infeasible — the gap and *ranked budget adjustments* to close it (e.g., "restaurants −$200/mo funds Greece by April").
  - Every number traceable to a formula; no black box.
- **[R]** Savings-plan generation: approve a plan → it becomes budget line items and shows up in the monthly review as on/off-track.
- **[+]** Goal timeline view: all goals on one horizontal timeline (wedding '26 → house '27–28 → kid '29…) with stacked monthly funding requirements — shows *collisions* between goals.
- **[+]** What-if scenarios: side-by-side worlds ("house in 2027 vs 2028", "one income for 12 months", "rate at 6%") without touching the real plan.
- **[+]** Priority trade-off view: when cash flow can't fund everything, an explicit slider — delay the house 6 months vs. trim the trip vs. reduce investing.

### D. Debt management **[+]** *(missing from the ask, present in the data)*
- Debt registry: balance, rate, minimum payment, per-person.
- Payoff planner: avalanche vs. snowball comparison, payoff dates, total interest cost.
- **Integration with the affordability engine**: extra cash is allocated across *debt payoff vs. goals vs. investing* by expected return — paying ~20% credit-card interest beats any investment, and the planner should say so explicitly.
- Debt-free countdown and interest-saved-to-date tracker (motivating for a couple).

### E. Investments & net worth — *"graph invested accounts, stocks, assets"*
- **[R]** Account value tracking: every investment account (Wealthsimple TFSA/FHSA, RBC TFSA/FHSA, cash) graphed over time from daily snapshots.
- **[R]** Holdings view: individual stocks/ETFs — quantity, book cost, market value, gain/loss, weight.
- **[R]** Portfolio dashboard: total value, asset allocation (equity/fixed income/cash/real estate), per-person and combined.
- **[+]** Contribution vs. growth decomposition: "portfolio +$12k: $9k contributions, $3k market" — the honest chart most apps hide.
- **[+]** Performance: time-weighted & money-weighted returns, vs. a benchmark (e.g., 60/40 or S&P/TSX composite).
- **[+]** Manual/illiquid assets: the $130k Buildings stake, vehicles — periodic manual revaluation with history.
- **[+]** Rental property mini-P&L: Buildings income vs. its expenses (Resend/Cloudflare/GoDaddy/Plaud are already tagged "Buildings Pay") → true net yield.
- **[+]** Net worth: assets − debts over time, the single headline chart; milestone markers ($150k, $200k…).
- **[+]** Dividend/distribution income tracking.
- **[+]** Allocation drift alert vs. target allocation (foundation for later rebalancing suggestions).
- Data source note: Plaid CA coverage confirmed for all our institutions including Wealthsimple — Plaid `investments`/`liabilities` is the primary path, with CSV import + manual entry kept as a backstop for anything Plaid can't see (e.g., the Buildings stake).

### F. Taxes & registered accounts — federal + Québec **[R]**

**F1. Simplified tax calculator (deterministic)**
- Per-person estimate of federal (T1) and Québec (TP-1) tax from data already in the system:
  - Employment income (from synced payroll deposits, grossed up via a stored salary profile), rental income net of Buildings expenses, investment income (interest, eligible-dividend gross-up + credit, 50% capital-gains inclusion).
  - Federal + Québec brackets, basic personal amounts, the 16.5% Québec abatement on federal tax, QPP/QPIP/EI contributions.
  - Deductions: RRSP and FHSA contributions. Credits (simplified set): donations (Centraide/Red Cross already budgeted), medical, tuition carry-forwards.
- Outputs per person and combined: estimated tax, marginal and average rates, and **balance owing vs. refund** (estimated withholding vs. liability), updated continuously through the year.
- Bracket/rate tables stored as versioned data (per tax year), not hardcoded — one small update per year.
- Explicitly a *simplified estimator* for planning — not filing software; final numbers come from your tax filing.

**F2. Contribution optimizer (deterministic solver)**
- Inputs: each person's income and marginal rates, available free cash flow from the budget, yearly purchase/goal funding requirements (from the affordability engine), a user-set cash buffer to maintain, and FHSA/RRSP/TFSA contribution room.
- Objective: maximize tax reduction subject to cash constraints — recommend how much each person should contribute to FHSA and RRSP (and route the remainder to TFSA, which doesn't reduce tax but shelters growth).
- Built-in ordering logic: FHSA first while the house goal is active (deductible like RRSP *and* tax-free out for a first home — strictly dominant for you); then RRSP prioritized to whoever has the higher marginal rate; RRSP deduction *carry-forward* when deferring the deduction to a higher-income year is worth more.
- Outputs: per-person monthly contribution schedule, estimated tax saved, projected refund — and a "refund recycling" suggestion (refund → credit card debt or goals) fed back into the affordability engine.
- Fully traceable: every recommendation shows the marginal-rate math behind it.

**F3. Couple coordination (agent-proposed strategies over F1/F2 outputs)**
- In Canada spouses file individual returns, but they're linked — the win is coordination, and this is where the agent layer proposes strategies computed by the deterministic engine:
  - **Spousal RRSP**: higher earner contributes and deducts, balances retirement income for later splitting.
  - **Credit pooling/transfer**: donations and medical expenses claimed on one return where it yields more; unused credits transferred between spouses.
  - **Who-holds-what**: taxable investments in the lower earner's name, registered maxed for the higher earner first.
  - **Timing**: RRSP top-up before the 60-day deadline sized to hit a target refund; deduction deferral in low-income years (e.g., parental leave).
- Each proposal shows the dollar impact from the calculator — accept it and it becomes part of the savings plan.

**F4. Room & deadline tracking**
- FHSA ($8k/yr, $40k lifetime), RRSP and TFSA room: entered once from CRA/Revenu Québec MyAccount, then auto-decremented by synced contributions.
- Deadline nudges: RRSP 60-day window, FHSA calendar year-end, TFSA re-contribution timing.
- Year-end checklist: contributions made vs. optimizer plan, donation receipts to collect.

### G. Household & couple features **[+]**
- Person lenses everywhere: Nick / Shanthi / Combined.
- Contribution & fairness view: who funds what, proportional-to-income option — makes the current per-person spreadsheet columns automatic.
- **Monthly "money date" mode**: a guided review page — last month's summary, variances worth discussing, goal progress, decisions to make — designed to be walked through together in 15 minutes.
- Shared decision log: "June '26: chose to fund Greece over extra CC payment" — future-you will want the why.
- Emergency-fund gauge: months-of-essentials covered (target 3–6 months ≈ $20–40k at current burn).

### H. Automation, reports & alerts **[+]**
- Nightly: sync all accounts → refresh balances → net-worth snapshot → recompute recurring/variance/goal status.
- Monthly: auto-generated household report (the money-date input) — archived so you can flip back through months.
- Alerts (in-dashboard, optionally email/push): overspend pace ("groceries 80% spent, day 18"), bill due / low balance ahead, goal off-track, price creep, renewal ahead, allocation drift, contribution-room deadline.
- Data health: stale-sync warnings, uncategorized-transaction count, reconciliation check (do balances move consistently with transactions).
- Backup: encrypted DB snapshot to a second disk/location on schedule.

### I. Agent layer — *later, by design*
- Everything in sections A–H is a deterministic function over SQLite: `computeCashFlow()`, `detectRecurring()`, `solveAffordability()`, `debtPayoffPlan()`, `portfolioPerformance()`, `estimateTax()`, `optimizeContributions()`…
- These get exposed as an **MCP server** (or in-platform assistant) so an agent can *call* them and narrate/advise over verified numbers — the agent reasons, the platform calculates.
- Natural-language queries ("can we afford the trip if we also max the FHSA?") become tool-call compositions, and the monthly report narrative gets written by the agent from deterministic inputs.
- **Couple tax strategy** (section F3) is the flagship agent use case: the agent enumerates coordination strategies (spousal RRSP, credit pooling, timing), prices each one through the deterministic tax engine, and presents ranked proposals with dollar impacts.

---

## 4. Platform architecture

```
                    ┌─────────────────────────────────────────────┐
                    │                Dashboard (web UI)            │
                    │   LAN-served by the existing Express app     │
                    └──────────────────────┬──────────────────────┘
                                           │ REST (existing app.ts)
┌──────────────┐    ┌──────────────────────┴──────────────────────┐
│  Ingestion    │    │        Deterministic analytics engine        │
│  - Plaid sync │───▶│  pure TS functions, unit-tested, no I/O:     │
│  - CSV import │    │  cashflow · variance · recurring · goals/    │
│  - manual     │    │  affordability · debt · portfolio · networth │
└──────┬───────┘    └──────────────────────┬──────────────────────┘
       │                                    │ (later: exposed via MCP)
       ▼                                    ▼
┌─────────────────────────────────────────────────────────────────┐
│              SQLite (data/finances.db) — schema v2               │
│  YubiKey vault unchanged · nightly jobs: sync + snapshot + calc  │
└─────────────────────────────────────────────────────────────────┘
```

Principles:
- **Local-first, unchanged**: vault, session grants, and data locality stay exactly as built.
- **Analytics = pure functions** in `src/analytics/` — take rows, return results, fully unit-testable. This is what makes the later MCP/agent layer trustworthy.
- **Pluggable ingestion** — Plaid is one source among several (CSV, manual), because Canadian coverage is uneven.
- **UI stays thin** — pages render engine outputs; no financial logic in the frontend.

## 5. Data model additions (schema v2)

New tables (existing `items/accounts/transactions` kept):

| Table | Purpose |
|---|---|
| `persons` | Nick, Shanthi, Joint — ownership lens on everything |
| `net_worth_snapshots` | daily per-account balance history (charts need history) |
| `categories`, `category_rules` | user category tree + merchant→category overrides |
| `budgets` | monthly target per category per person, versioned |
| `recurring_payments` | registry: amount, cadence, account, next/end date, reimbursed_by |
| `debts` | balance, APR, minimum payment (CC, student loan, LOC, future mortgage) |
| `goals` | type (house/kid/trip/purchase/savings/event), target amount+date, priority, linked account (e.g., FHSA), status |
| `goal_plans` | solver output: monthly funding schedule, approved version |
| `holdings`, `securities`, `security_prices` | investment positions + price history |
| `manual_assets` | Buildings stake, vehicles — value history via revaluations |
| `registered_accounts` | FHSA/TFSA/RRSP room and contribution tracking |
| `tax_profiles` | per-person salary, withholding, carry-forwards, filing inputs |
| `tax_tables` | versioned federal + Québec brackets/rates/credits per tax year |
| `tax_estimates` | calculator + optimizer outputs over time (audit trail) |
| `scenarios` | what-if parameter sets |
| `reports` | archived monthly reports |
| `decisions` | couple's decision log |

## 6. Dashboard pages

1. **Home** — net worth headline + trend, month cash-flow pulse, alerts, goal progress strip, next 7 days of bills.
2. **Cash Flow** — income vs. spend, category breakdown, 12-month flux matrix, person lens.
3. **Budget** — budget vs. actual with variance flags and narratives; edit budgets; uncategorized inbox.
4. **Bills & Recurring** — registry, calendar view, projected balance curve, renewal/price-creep alerts.
5. **Goals & Planning** — goal cards, affordability solver, timeline/collision view, scenario compare, savings-plan approval.
6. **Debt** — payoff plan, avalanche/snowball compare, countdown, interest saved.
7. **Investments** — accounts over time, holdings, allocation vs. target, contribution-vs-growth, performance vs. benchmark, Buildings P&L.
8. **Net Worth** — full history, assets vs. debts, milestones.
9. **Taxes** — per-person + combined estimate (owing/refund), marginal-rate gauges, contribution optimizer with accept-plan button, room & deadline tracker, couple-strategy proposals.
10. **Monthly Review** — the money-date page: report, discussion points, decision log.
11. **Accounts & Connections** — link banks via Plaid Link, three-step add-bank wizard (connect → select accounts → classify owner/type/purpose), per-institution sync health, in-place reclassification; doubles as first-run onboarding.

## 7. Phased roadmap

| Phase | Scope | Outcome |
|---|---|---|
| **1. Foundation** | Schema v2 · persons/categories/rules · seed categories+budgets from the Excel · nightly sync + snapshot job · CA country code | Data flowing, history accumulating |
| **2. Visibility** | Home, Cash Flow, Budget pages · budget vs. actual + variance · uncategorized inbox | "Where is our money going" answered; spreadsheet retired |
| **3. Bills & Debt** | Recurring registry + auto-detection · bills calendar + projections · debt module + payoff planner | No surprises; debt strategy explicit |
| **4. Goals** | Goal types · affordability solver · savings-plan generation · timeline + scenarios | "Can we afford it, by when" answered |
| **5. Wealth** | Holdings/prices ingestion (Plaid `investments`) · investments + net worth pages · registered-account room | Full wealth picture graphed |
| **6. Tax** | Federal + Québec calculator · contribution optimizer · Taxes page · deadline nudges | Tax estimate live; FHSA/RRSP plan optimized |
| **7. Automation** | Monthly report · alerts · money-date mode · backups | System runs itself |
| **8. Agent** | MCP server over the analytics engine · couple tax-strategy proposals · narrative reports · NL queries | Advisor on top of verified numbers |

## 8. Open decisions

1. ~~Investment data source~~ — **resolved**: Plaid CA coverage confirmed for all banks incl. Wealthsimple. Ingestion stays pluggable (CSV/manual as backstop), but Plaid `investments` + `liabilities` is the primary path.
2. **Frontend stack** — recommend Vite + React + a chart lib (Recharts/ECharts), served by the existing Express app on the LAN; simple auth (shared PIN) since it's two users at home.
3. **Alert delivery** — dashboard-only first; email/push later if wanted.
4. **Currency** — CAD base; USD accounts converted at daily rate (Wealthsimple USD exists today).
5. **Tax scope line** — the calculator is a planning estimator (employment, rental, investment income; RRSP/FHSA deductions; core credits). Confirm what stays out of scope for v1: self-employment/corp income, capital-loss carry-backs, Québec-specific credits like Solidarity/work premium.
