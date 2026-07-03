# Engine Service Structure

*Companion to [PLATFORM_PROPOSAL.md](PLATFORM_PROPOSAL.md), [DATA_MODEL.md](DATA_MODEL.md), [FRONTEND_DESIGN.md](FRONTEND_DESIGN.md). Every file below exists as a stub whose header comment is its contract: what it contains, what it depends on, what it exposes. This doc is the map.*

## The dependency rule

```
server/routes  →  engine services  →  db/repositories   (I/O: SQLite)
                        ↓          →  analytics/*        (pure, ZERO I/O)
jobs           →  engine services
```

- **`analytics/`** — pure functions. Never imports db/, plaid/, server/, engine/. Fully unit-testable with plain fixtures; becomes the MCP tool surface in the final phase, verbatim.
- **`engine/`** — orchestration. Loads rows via repositories, calls analytics, shapes page payloads. Owns thresholds and defaults.
- **`db/repositories/`** — domain-split data access, same better-sqlite3 conventions as the existing [repository.ts](../src/db/repository.ts) (which keeps owning the banking core: items/accounts/transactions/persons).
- **`server/routes/`** — thin: zod-validate → buildContext → one service call → json. Pattern-identical to the existing routes (vaultGuard, asyncHandler).
- **`jobs/`** — the scheduler and pipelines; call services only.
- **[server/contracts.ts](../src/server/contracts.ts)** — every request/response type + zod body schema, imported by both routes and the web app (`@contracts` path alias), so frontend and backend can't drift.

## File tree (new files; ✎ = existing file needs a small edit)

```
src/
  analytics/                     pure deterministic layer (19 files)
    types.ts        calendar.ts      money.ts
    cashflow.ts     variance.ts      categorize.ts
    recurring.ts    projection.ts    debt.ts
    goals.ts        affordability.ts portfolio.ts    networth.ts
    tax/  types.ts  payroll.ts  federal.ts  quebec.ts
          estimator.ts  optimizer.ts  couple.ts
    index.ts                     barrel = the engine's public deterministic API
  engine/                        orchestration services (13 files)
    context.ts                   lens/month/fx resolution — first arg everywhere
    cashflowService.ts   budgetService.ts    categorizationService.ts
    recurringService.ts  debtService.ts      planningService.ts
    portfolioService.ts  networthService.ts  taxService.ts
    alertsService.ts     reportService.ts
    snapshotService.ts   fxService.ts
  db/
    repositories/                domain data access (8 files)
      budgeting.ts  recurring.ts  debts.ts  planning.ts
      investments.ts  history.ts  tax.ts  ops.ts
    repository.ts ✎              stays: banking core (already has classification)
  plaid/
    investments.ts               (dormant — needs Plaid production tier; kept for later)
  engine/
    marketDataService.ts         Yahoo Finance daily closes for user-entered symbols
    positionsService.ts          manual positions (versioned) → snapshot rebuild → reconciliation
  jobs/
    scheduler.ts  nightly.ts  monthlyReport.ts
  server/
    contracts.ts                 shared API types + zod schemas
    routes/                      new HTTP surfaces (9 files)
      cashflow.ts  budget.ts  bills.ts  debts.ts  goals.ts
      portfolio.ts  networth.ts  tax.ts  ops.ts
    app.ts ✎                     register new routers
  index.ts ✎                     startScheduler(app) after vault unlock
scripts/
  seed-from-workbook.ts          (to write) Excel → categories/budget/debts/goals
```

## Service → endpoint → page map

| Service | Key endpoints | Feeds (frontend) |
|---|---|---|
| cashflowService | `/api/cashflow/{summary,sankey,flux,category/:id}` | Cash Flow page, Overview KPIs |
| budgetService + categorizationService | `/api/budget*`, `/api/categories*` | Budget page, inbox |
| recurringService | `/api/bills/*` | Bills calendar + ribbon, registry, proposed tray |
| debtService | `/api/debts/*` | Debt page payoff mountain, compare |
| planningService | `/api/goals*`, `/api/plans*`, `/api/scenarios*` | Goals timeline, solver, plan approval |
| portfolioService | `/api/portfolio/*`, `/api/assets*` | Investments page, Buildings P&L |
| networthService | `/api/networth*` | Net Worth page, Overview hero |
| taxService | `/api/tax/*` | Taxes page: estimate, optimizer, strategies, room |
| alerts/report (ops route) | `/api/alerts*`, `/api/reports*`, `/api/review/:month`, `/api/overview`, `/api/decisions`, `/api/settings` | Bell, Review story mode, Overview aggregate |

Latency-sensitive endpoints (drive live drag interactions, must stay side-effect-free): `POST /api/goals/solve/preview`, `POST /api/tax/optimize`.

## Nightly pipeline (jobs/nightly.ts)

sync → investments sync → fx → snapshots → categorize + transfer sweep → recurring match/detect → contribution detection → goal/plan refresh → alert evaluation. Bracketed by a `sync_runs` row; independent step failures don't abort the rest.

## Frontend consumption (web/, to scaffold in Phase 2)

React + TypeScript + Vite, **ECharts** via a thin `<Chart option={...}>` wrapper (echarts-for-react or custom), Framer Motion, TanStack Query, Zustand. Planned tree:

```
web/src/
  api/client.ts        typed fetch built on @contracts types
  stores/              lens.ts · month.ts · theme.ts (Zustand)
  charts/              option builders: engine payload → EChartsOption
                       (sankey.ts, heatmap.ts, mirroredArea.ts, payoff.ts,
                        rings.ts, ribbon.ts — animation grammar lives here)
  components/          shell (Sidebar, TopBar, LensSwitch, MonthScrubber),
                       cards, tickers (odometer), alert stack
  pages/               Overview · CashFlow · Budget · Bills · Goals · Debt ·
                       Investments · NetWorth · Taxes · Review · Accounts
```

Contract guarantees the engine makes to this layer:
1. Every chart endpoint returns series in ECharts-native shape (nodes/links, `[date, value]` pairs, heatmap triplets) — option builders add style/animation only, never re-aggregate.
2. Every money value arrives CAD-converted and cent-rounded; the person lens is resolved server-side (`?lens=` param) so the frontend never sums across persons itself.
3. All figures for one page arrive in ≤2 requests (Overview in exactly 1: `/api/overview`).

## Test strategy

- `analytics/` — vitest unit tests with fixture rows; golden tests for the tax estimator against published CRA/RQ examples per tax year; property tests for the recurrence expander and solver (never allocates more than supply, respects buffer).
- `engine/` — integration tests over an in-memory SQLite seeded by the migrations + workbook seed.
- `server/` — supertest smoke per route (shape + auth guard).

## Build order — four steps (tracked as tasks #1–#4)

Each step lands a self-contained, tested capability; later steps only consume, never rework, earlier ones.

1. **Foundation: seed, cashflow, budget.** Workbook seed script (categories, June-2026 budget, debts, wedding/Greece goals) · analytics {types, calendar, money, cashflow, variance, categorize} · budgeting repo · context · cashflow/budget/categorization services · contracts first slice · cashflow + budget routes · vitest setup. *Done when `/api/cashflow/*` and `/api/budget/*` are correct for the seeded month.*
2. **Time: bills, debt payoff, history & nightly job.** analytics {recurring, projection, debt} · recurring/debts/history repos · recurring/debt/snapshot/fx services · scheduler + nightly v1 (sync → fx → snapshots → categorize → match/detect, `sync_runs`-bracketed) · bills + debts routes · CA country code. *Done when the nightly runs idempotently and bills calendar + payoff compare are correct.*
3. **Wealth: investments, net worth, goals & solver.** plaid/investments (+`PLAID_PRODUCTS`) · analytics {portfolio, networth, goals, affordability} · investments/planning repos · portfolio/networth/planning services · portfolio + networth + goals routes · nightly gains holdings snapshots + goal refresh · solver property tests, `/solve/preview` <50ms. *Done when net worth/portfolio series build from snapshots and solve → plan approval round-trips.*
4. **Tax, alerts, reports & overview.** Full analytics/tax package + 2026 CA/QC tables as data with golden tests · tax/ops repos · tax/alerts/report services · tax + ops routes (incl. the one-shot `/api/overview`) · nightly completes (contributions, alerts) + monthlyReport job. *Done when estimates match golden fixtures, optimizer-accept writes plan lines, alerts fire from fixtures — engine complete, analytics/index.ts frozen as the MCP-ready surface.*
