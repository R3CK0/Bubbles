# Frontend Design — "Sage & Slate"

*Companion to [PLATFORM_PROPOSAL.md](PLATFORM_PROPOSAL.md), [DATA_MODEL.md](DATA_MODEL.md), and [ENGINE_STRUCTURE.md](ENGINE_STRUCTURE.md). Defines the visual language, navigation, interaction/animation behavior, and — now that the engine API exists — the exact wiring between every page and the endpoints in [contracts.ts](../src/server/contracts.ts) / `src/server/routes/`.*

## 1. Design language

**Mood**: calm, confident, private-banking-meets-modern-app. Money is stressful; the UI shouldn't be. Generous whitespace, soft depth (no hard borders — elevation via subtle shadows and surface tints), rounded 16px cards, and motion that explains rather than decorates.

### Palette — green & gray, dual theme

| Token | Dark (default) | Light | Role |
|---|---|---|---|
| `--bg` | `#101413` charcoal-green | `#F6F7F6` warm paper | app background |
| `--surface` | `#181D1B` | `#FFFFFF` | cards |
| `--surface-2` | `#1F2624` | `#EEF1EF` | nested panels, table stripes |
| `--ink` | `#E8ECEA` | `#1A201E` | primary text |
| `--ink-muted` | `#8A948F` | `#66706B` | labels, secondary |
| `--accent` | `#34D399` emerald | `#0F766E` deep teal-green | primary actions, positive values |
| `--accent-soft` | `#34D39918` | `#0F766E14` | accent washes, chart fills |
| `--gold` | `#D9B36C` | `#A97F2D` | milestones, "wealth" moments (net-worth records, goal achieved) |
| `--warn` | `#F5B04C` | `#B4690E` | overspend pace, renewals |
| `--danger` | `#F0716A` | `#B3382F` | debt, critical alerts (used sparingly) |

Rules: green means *growth and positive flow*, never generic decoration. Negative values pair color with a directional glyph (▲/▼) so red/green is never the only signal. Gray does the talking; green does the pointing.

### Typography
- **UI**: Inter (or Geist) — 14px base, 13px tables.
- **Numbers**: same family with `font-variant-numeric: tabular-nums` everywhere a figure appears — columns align, tickers don't jitter.
- **Hero figures** (net worth, monthly remaining): 40–56px, weight 600, tight tracking. The number is the interface.

### Depth & texture
- Elevation by tint, not line: cards are `--surface` on `--bg` with a 1px inner border at 6% white (dark) / 4% black (light) and a soft 24px shadow at 25% opacity.
- One signature flourish: the app background carries an extremely faint radial gradient of `--accent` (2–3% opacity) drifting slowly (120s loop) behind the Overview — alive, not distracting. Disabled under `prefers-reduced-motion`.

## 2. Stack

| Concern | Choice | Why |
|---|---|---|
| Build/app | Vite + React + TypeScript | fast, boring, fits existing Express serving `dist/web` |
| Styling | Tailwind CSS v4 + CSS variables for tokens | theme switch = swapping the token block |
| Motion | Framer Motion | shared-layout (FLIP) transitions, spring physics, `useReducedMotion` |
| Charts | Apache ECharts (canvas) | best-in-class built-in animations: series *morph* between states, native sankey/heatmap/gauge |
| Micro-charts | Custom SVG sparklines animated with Framer | cheap, crisp, animate with the card they live in |
| Data | TanStack Query | cache + background refetch after nightly sync |
| Routing | React Router | code-split per page |
| UI state | Zustand (person lens, month cursor, theme) | tiny, global, no ceremony |

Served by the existing Express app on the LAN; in dev, Vite proxies `/api/*` to `:4000`. Auth: shared household PIN → session cookie (it's two users at home; the YubiKey continues to guard the *server*, the PIN guards the *screen*). **Note: the PIN/session layer does not exist server-side yet — see §9 gaps.**

Planned tree (mirrors [ENGINE_STRUCTURE.md](ENGINE_STRUCTURE.md) §Frontend consumption):

```
web/src/
  api/client.ts        typed fetch built on @contracts types (see §3)
  api/queries.ts       TanStack Query hooks, one per endpoint, keyed by (endpoint, lens, month)
  stores/              lens.ts · month.ts · theme.ts (Zustand, persisted to localStorage)
  charts/              option builders: engine payload → EChartsOption
                       (sankey.ts, heatmap.ts, mirroredArea.ts, payoff.ts,
                        rings.ts, ribbon.ts — animation grammar lives here)
  components/          shell (Sidebar, TopBar, LensSwitch, MonthScrubber),
                       cards, tickers (odometer), alert stack, VaultBanner
  pages/               Overview · CashFlow · Budget · Bills · Goals · Debt ·
                       Investments · NetWorth · Taxes · Review · Accounts · Settings
```

## 3. Data layer & API conventions

This section is the contract every page below builds on. The backend guarantees (per [ENGINE_STRUCTURE.md](ENGINE_STRUCTURE.md)):

1. **ECharts-native payloads.** Every chart endpoint returns series ready to plot (sankey nodes/links, `[date, value]` pairs, heatmap triplets). Option builders add style/animation only — the frontend never re-aggregates.
2. **Money is resolved server-side.** All values arrive CAD-converted and cent-rounded; the person lens is applied by the engine. The frontend never sums across persons.
3. **≤2 requests per page.** Overview is exactly one (`GET /api/overview`).

### Global query params — the lens & month contract

Every engine endpoint (`/api/cashflow/*`, `/api/budget*`, `/api/bills/*`, `/api/debts*`, `/api/networth*`, `/api/portfolio/*`, `/api/goals*`, `/api/tax/*`, `/api/overview`, `/api/review/*`) accepts the same context query, parsed by [context.ts](../src/engine/context.ts):

- `?lens=` — a `person_id` or `combined` (default). Unknown values → 400. Person ids come from `GET /api/persons`.
- `?month=YYYY-MM` — defaults to the current month; sets the analysis window.
- `?from=YYYY-MM-DD&to=YYYY-MM-DD` — overrides the month window for arbitrary ranges (chart zoom/brush "Zoom to range").

The **lens switch and month scrubber therefore never touch component state** — they update the Zustand store, which is folded into every query key: `['cashflow.sankey', lens, month]`. Switching lens/month triggers TanStack refetches; ECharts `animationDurationUpdate` morphs old series into the new response (the §4 grammar). Because responses are cached per `(endpoint, lens, month)`, scrubbing back to a visited month is instant.

### Fetch layer

`api/client.ts` is a thin typed `fetch` wrapper importing **types and zod schemas only** from [contracts.ts](../src/server/contracts.ts) (the module has no server runtime imports, by design — a `@contracts` path alias). Conventions:

- JSON in/out, zod-validated bodies before send (same schemas the server parses — client-side validation is free).
- Non-2xx → typed `ApiError { status, message }`. 400s from zod render as inline form errors; 404s as empty states; 503s specifically mean **vault locked** (below).
- Mutations return the written row (`{ goal }`, `{ debt }`, `{ recurring }`…) — used for optimistic cache patches before the invalidation lands.

### Two API tiers: engine (always on) vs. Plaid (vault-gated)

The server mounts engine routes *before* the vault guard on purpose ([app.ts](../src/server/app.ts)): the dashboard keeps working when the YubiKey session expires. Two behaviors follow:

- **Engine tier** — everything analytical (all §5 dashboards). Never 503s for vault reasons.
- **Plaid tier** — `/api/link/*`, `/api/items*`, `/api/accounts*` (incl. `GET /api/persons`), `/api/sync`, `/api/transactions`, `/api/balances`. These 503 when the vault is locked.

The shell polls `GET /api/vault/status` (60s interval + on window focus) → `{ initialized, unlocked, session: { valid, … } }`. When locked, a slim **VaultBanner** docks under the top bar ("Bank connection locked — unlock on the server to sync"), the Accounts page shows its locked state, and sync buttons disable. Dashboards stay fully alive.

Because `GET /api/persons` sits behind the guard, the persons list (needed by the lens switch on every page) is fetched once when unlocked and **persisted in the Zustand store** so a locked vault never breaks the lens control. (§9 recommends moving that route out of the guard.)

### Cache invalidation map

Mutations invalidate query *families* (prefix match), because engine numbers cascade:

| Mutation | Invalidate |
|---|---|
| categorize / rule save / rule delete | `cashflow.*`, `budget.*`, `overview`, `review.*` |
| budget lines PUT | `budget.*`, `overview` |
| bill create/patch/delete/accept/dismiss | `bills.*`, `overview`, `goals.*` (free cash flow shifts) |
| debt create/patch | `debts.*`, `networth.*`, `overview`, `goals.*` |
| goal create/patch/items, plan approve | `goals.*`, `plans.*`, `overview`, `tax.strategies` |
| position/asset/valuation writes, positions refresh | `portfolio.*`, `positions`, `networth.*`, `overview` |
| tax room/profile PUT, optimize accept | `tax.*`, `goals.*`, `plans.*` |
| settings PUT | everything (buffer/base-currency feed the solver and projections) |
| account classify PATCH | everything (owner/type rewrites every lens split) |
| any sync (`/api/sync`, item sync, nightly run) | everything, **after** the response lands |

"Invalidate everything" is cheap here: it's a LAN app with a single household of data; TanStack refetches only mounted queries.

### Polling & liveness

- `overview` refetches on window focus and every 5 min (keeps the sync dot honest via `lastSync`).
- After triggering `POST /api/jobs/nightly/run` or `POST /api/sync`, the button holds a spinner for the request's duration (they're synchronous — the response *is* the completion), then global invalidation runs and new-transaction counts pop in from the response payload.
- The two latency-sensitive endpoints — `POST /api/goals/solve/preview` and `POST /api/tax/optimize` — are **side-effect-free by contract** and safe to hammer: throttle to one in-flight request (drop-stale pattern: fire, and if the input changed while awaiting, fire once more with the latest value).

## 4. Navigation & shell

### Layout
- **Left sidebar**, 232px, collapsible to a 64px icon rail (state remembered). Sections: Overview · Cash Flow · Budget · Bills · Goals · Debt · Investments · Net Worth · Taxes · Review, with **Accounts** pinned at the bottom next to Settings. The active item carries a pill highlight that **slides** between items (Framer `layoutId`) rather than blinking from one to the next.
- **Top bar**: three controls, global to every page —
  1. **Person lens** — segmented pill `Nick | Shanthi | Both`. Backed by `GET /api/persons` (cached, see §3); "Both" sends `lens=combined`. Switching does not reload: every figure on screen *rolls* to its new value (odometer ticker, 400ms), charts morph their series in place. The lens is the single most-used control, so it must feel instant — cached months render from cache while the refetch confirms.
  2. **Month scrubber** — current month with ‹ › steppers; click opens a horizontal 12-month strip you can drag/scrub, and every chart follows the scrub live (throttled to animation frames; data swaps per §3 cache).
  3. **Sync + alerts** — a small dot that breathes green when `overview.lastSync` < 24h (amber when stale, gray when the vault is locked), and a bell whose badge is `overview.alerts.length`, incrementing with a little spring pop. The bell's dropdown lists open alerts; dismissing one calls `POST /api/alerts/:alertId/ack`.
- **Command palette** (⌘K): jump to any page, search transactions ("costco march" → `GET /api/transactions` filtered client-side until a search param exists, see §9), or run quick actions ("add goal", "recategorize").
- **Tablet/phone** (couch use): sidebar becomes a bottom tab bar with the 5 core pages + "More" sheet; charts switch to touch scrubbing.

### Page transitions
Crossfade + 12px vertical slide, 250ms ease-out, content staggering in top-to-bottom (60ms between rows). Where a navigation is a *zoom-in* (card → its page, transaction row → detail), a **shared-element transition** carries the element: the KPI card's sparkline expands into the full chart on the destination page — the axes fade in around it, so continuity is literal, not implied.

## 5. Chart behavior (the signature of the app)

Charts follow one grammar everywhere:

1. **Entrance**: axes and gridlines fade in first (150ms), then the data **draws** — lines sweep left→right (~900ms ease-out) with their gradient area fading up behind (green above zero, gray below); bars grow from the baseline with a 25ms stagger; donuts sweep clockwise from 12 o'clock; heatmap cells fade in as a diagonal wave.
2. **State change ≠ redraw**: change the lens, the month, or a toggle, and existing series **morph** to their new geometry (ECharts `animationDurationUpdate: 600`). You watch March become April; nothing flashes.
3. **Hover**: a thin vertical crosshair snaps to the nearest data point (magnetic), the point blooms a soft halo, and a tooltip follows with date + values in tabular figures. On multi-series charts the tooltip lists all series sorted by value.
4. **Scrub & brush**: press-drag on any time chart selects a range; on release, a floating stats chip springs up (Δ, %, avg/mo for the selection) with "Zoom to range" — zooming refetches with `?from&to` and animates the axes rescaling. Double-click resets, animated back.
5. **Expand**: every chart card has an expand affordance (and responds to click-anywhere-on-mini-charts). Expansion is a FLIP transition into a **full-screen detail view**: the mini chart *is* the big chart, growing in place while controls dock around it — range presets (3M/1Y/All → the endpoint's `days`/`months` param), granularity (day/week/month), compare toggle (vs. last year / vs. budget / Nick-vs-Shanthi dual line — two parallel queries with each lens), and an "explain" panel listing the underlying rows. Esc or a pinch-shrink returns it, reversing the FLIP.
6. **Reduced motion**: `prefers-reduced-motion` swaps every draw/morph for a 150ms fade and kills the ambient background — same information, no theatre.
7. **Performance rule**: only `transform`/`opacity` animate in DOM; series animation stays on ECharts' canvas; transaction tables virtualize past 100 rows. 60fps or the animation gets cut.

## 6. Page-by-page

Each page lists its **API wiring** — the exact endpoints it owns, when they fire, and what they feed. Together these cover the entire HTTP surface (inventory in §10).

### Overview (home)
The answer to "how are we doing?" in five seconds. **One request: `GET /api/overview`** — it aggregates hero, cashflow summary, goal rings + feasibility verdicts, next-7-days bills, low-balance windows, open alerts, uncategorized count, and `lastSync`.

- **Hero**: combined net worth (`hero`), 48px, ticking up from its previous session value on load (900ms odometer) with a ▲ monthly delta chip; behind it a 90-day area sparkline draws in. A gold milestone flag plants itself on the line when a record is crossed. Click → Net Worth page (shared element).
- **Four KPI cards** (Money in · Money out · Remaining this month · Invested) from `cashflow`, each with a sparkline; cards raise 2px on hover, click zooms (shared element) into their page.
- **Goal strip**: horizontally scrollable ring cards from `goals[]` (`progress` fills the ring, `feasible: yes/tight/no` tints it green/amber/red), rings sweeping to their fill on mount, staggered 80ms.
- **Next 7 days**: compact bill list from `next7Days[]`; each row's due-date dot pulses once amber if the day falls inside a `lowWindows` span.
- **Alert cards** from `alerts[]` slide in from the right edge, stack, and settle; dismissing swipes them away with a spring and fires `POST /api/alerts/:alertId/ack { personId }` (the ack records *who* dismissed).
- **Uncategorized nudge**: when `uncategorized > 0`, a quiet chip ("14 to categorize") deep-links to the Budget inbox.

| Call | When |
|---|---|
| `GET /api/overview?lens&month` | mount, lens/month change, focus, 5-min poll |
| `POST /api/alerts/:alertId/ack` | alert dismissed |

### Cash Flow
- **Sankey diagram** as the centerpiece from `GET /api/cashflow/sankey` (returns ECharts-native `nodes`/`links`): Income streams (Nick / Shanthi / Buildings) flow left→right through "Household" into category branches. On load, flows *pour* — link opacity and width animate in over 1.2s. Hovering a link dims everything else and shows the amount; **clicking a category node** fetches `GET /api/cashflow/category/:categoryId` and splits the node in place into its subcategories, the sankey reflowing around it. Lens switch re-pours only the affected streams.
- **KPI strip** (in/out/net/savings-rate) from `GET /api/cashflow/summary` — shares its query with the Overview cards so the shared-element zoom lands on already-cached data.
- **Flux matrix** (the Excel table, alive): `GET /api/cashflow/flux?months=12` (up to 36) renders the month × category heatmap, green-tinted under budget / amber over; cells fade in diagonally. Click a cell → a right-side **drawer** slides in with that month-category's transactions, mini trend, and variance narrative — all served by `GET /api/cashflow/category/:categoryId?month=` (the drilldown includes the transaction rows; no separate `/api/transactions` call needed).

| Call | When |
|---|---|
| `GET /api/cashflow/summary?lens&month` | mount, lens/month change |
| `GET /api/cashflow/sankey?lens&month` | mount, lens/month change |
| `GET /api/cashflow/flux?months=12&lens` | mount, lens change |
| `GET /api/cashflow/category/:categoryId?lens&month` | node click / cell click (drawer) |

### Budget
- Category rows from `GET /api/budget` (the `BudgetView`: per-category budget vs. actual vs. pace), each with a **dual-bar**: gray track = budget, green fill = actual, animating to width on mount. Overspend renders the overflow as an amber cap that pulses *once*. Variance chip (▲$142) sits right-aligned.
- Rows **expand accordion-style** into subcategory bars + a 6-month mini trend + "set budget" inline editor. Committing the editor calls `PUT /api/budget/lines { effectiveFrom: "YYYY-MM", lines: [{categoryId, personId, monthlyAmount}] }` — budgets are **versioned**, so the write creates/extends a version effective from that month; the "Remaining" figure in the page header ticks to its new value on the refetch. A small "history" affordance lists `GET /api/budget/versions`.
- **Variance narratives**: `GET /api/budget/variances` returns per-category plain-language narratives ("Groceries ran $180 over, driven by 3 Costco runs") — shown in the expanded row and reused by Review.
- **Uncategorized inbox**: `GET /api/categories/inbox?limit=25` returns card data (merchant, amount, suggested category with confidence). One transaction at a time, big merchant name, suggested category as the primary button. Keyboard-first: number keys pick categories, the card flies off and the next springs up; each pick posts `POST /api/transactions/:transactionId/categorize { categoryId }` (null = mark as transfer/ignore). A "always do this" toggle on the card escalates the pick into a rule: `POST /api/categories/rules { merchantPattern, categoryId, retroactiveMonths }` — the response reports how many past transactions were re-tagged, shown as a toast ("Rule saved — 12 past transactions updated"). Clearing the stack earns a brief all-clear state.
- **Category & rule managers** (secondary, behind a "Manage" tab): category tree editor over `GET/POST /api/categories` (create/rename/archive/re-parent via the upsert), and a rules table over `GET /api/categories/rules` with priority ordering, `POST /api/categories/rules` to add/edit, `DELETE /api/categories/rules/:ruleId` to remove. Every categorize/rule write invalidates `cashflow.*` — the sankey and flux quietly morph on next visit.

| Call | When |
|---|---|
| `GET /api/budget?lens&month` | mount, lens/month change |
| `GET /api/budget/variances?lens&month` | mount |
| `PUT /api/budget/lines` | inline budget editor commit |
| `GET /api/budget/versions` | history affordance |
| `GET /api/categories` · `POST /api/categories` | manage tab |
| `GET /api/categories/rules` · `POST` · `DELETE /:ruleId` | manage tab, inbox "always" toggle |
| `GET /api/categories/inbox?limit` | inbox open, after each stack clear |
| `POST /api/transactions/:id/categorize` | every inbox pick |

### Bills & Recurring
- **Month calendar + projected balance ribbon** from a single `GET /api/bills/calendar` (the `BillsCalendar`: per-day expected bills + projected running balance + `lowWindows`). Amount dots on the calendar; below it the ribbon area chart. Hovering a calendar day drops a plumb line onto the ribbon; days inside a low window glow amber. Payday bumps are visible as steps.
- The **registry table** from `GET /api/bills/registry?status=active` shows each bill with next-due countdown and a price-history sparkline; a **price-creep badge** (▲ $2.40 since Jan) sits on offenders. Row edit opens a form that submits the full `recurringSchema` body to `PATCH /api/bills/:rpId` (note: the PATCH takes the *complete* body, not a partial — the form must round-trip every field). Delete → `DELETE /api/bills/:rpId`. "Add bill" → `POST /api/bills` (name, expectedAmount, frequency + anchorDate, optional category/person/account, `autopay`, `reimbursedBy: work|buildings`, and `debtId` to tie a payment to a debt so the payoff plan sees it).
- **Proposed tray**: `GET /api/bills/registry?status=proposed` — auto-detected recurring candidates arrive at top with accept/dismiss. Accept fires `POST /api/bills/:rpId/accept` and animates the row flying into its slot in the table; dismiss fires `POST /api/bills/:rpId/dismiss`.
- **Renewals rail**: `GET /api/bills/renewals?days=60` lists annual/semiannual renewals coming up (insurance, subscriptions) as amber chips — the "why is this month heavy" answer.

| Call | When |
|---|---|
| `GET /api/bills/calendar?lens&month` | mount, lens/month change |
| `GET /api/bills/registry?status=` | mount (active + proposed in parallel) |
| `POST /api/bills` · `PATCH /api/bills/:rpId` · `DELETE /api/bills/:rpId` | add/edit/remove |
| `POST /api/bills/:rpId/accept` · `.../dismiss` | proposed tray actions |
| `GET /api/bills/renewals?days=60` | mount |

### Goals & Planning
- Page data from `GET /api/goals` — the `GoalsView` bundles goal cards *and* the current solve (per-goal `feasible` verdict, required monthly, funding schedule), so the timeline renders from one request.
- **Timeline view**: horizontal time axis (now → +5y), goals as rounded bars with progress fill. **Drag a goal's target date** and the affordability solver re-runs live via `POST /api/goals/solve/preview { goalShifts: [{goalId, targetDate}] }` — the drag handler throttles to one in-flight request (§3), each response springs the feasibility chips (green ✓ / amber ~ / red ✕) and ticks the "required monthly" figures. Collisions (months where demands exceed free cash flow) shade the timeline background red-gray from the solve response. The preview endpoint is side-effect-free by contract — hammer away. Optional what-if knobs (extra free cash flow, different buffer) map to the same body's `freeCashFlowMonthly` / `bufferTarget`.
- **Committing**: a "Save as plan" button posts the current overrides to `POST /api/plans/approve { name, overrides }`; the active plan (shown as a subtle baseline on the timeline) reads from `GET /api/plans/active`.
- Goal CRUD: `POST /api/goals` (type: house/kid/trip/purchase/savings/event/emergency_fund/debt_payoff; target amount/date, priority 1–5, optional `linkedAccountId` so a tagged account auto-feeds the ring, or `linkedDebtId` for payoff goals), `PATCH /api/goals/:goalId` (rename, re-date, re-prioritize, pause/abandon/achieve). Completing a goal draws the checkmark and bursts the ring once in `--gold` — the app's single celebratory moment.
- **Line items** (trip/wedding budgets): inside a goal's detail, itemized costs via `POST /api/goals/:goalId/items { name, amount, dueDate, status: planned|deposit_paid|paid|cancelled, transactionId? }` and `DELETE /api/goals/items/:lineId` — paid items link to real transactions and advance the ring.
- **Scenario compare**: side-by-side world A/B with a draggable center divider; A = live solve, B = a saved scenario. Scenarios persist via `GET/POST /api/scenarios` (`params`: free-cash-flow delta, buffer, goal shifts) and `DELETE /api/scenarios/:scenarioId`; side B's numbers come from `POST /api/scenarios/:scenarioId/solve`. Both timelines scrub together.

| Call | When |
|---|---|
| `GET /api/goals?lens&month` | mount, lens change |
| `POST /api/goals/solve/preview` | continuously during drag (throttled) |
| `POST /api/plans/approve` · `GET /api/plans/active` | commit / baseline |
| `POST /api/goals` · `PATCH /api/goals/:goalId` | create/edit |
| `POST /api/goals/:goalId/items` · `DELETE /api/goals/items/:lineId` | line items |
| `GET/POST /api/scenarios` · `DELETE /:scenarioId` · `POST /:scenarioId/solve` | scenario compare |

### Debt
- Header stats (total balance, weighted APR, debt-free date, interest saved) from `GET /api/debts`.
- **Payoff mountain**: `GET /api/debts/payoff?strategy=avalanche&extra=200` returns the stacked per-debt balance projection melting toward zero. The avalanche/snowball toggle refetches with the other `strategy` and **morphs the curves**; an **extra-payment slider** re-queries with `extra=` (debounced 150ms — it's a fast local computation). Scrubbing shows per-debt balances at any future date from the same series.
- The comparison chip ("Avalanche: debt-free 4 months sooner, $3,214 less interest") comes from `GET /api/debts/compare?extra=` — one request, both strategies summarized.
- Debt CRUD: `POST /api/debts` (also reachable from the Accounts wizard — kind, balance, APR, min payment, payment day) and `PATCH /api/debts/:debtId` for balance corrections, APR changes, or `status: paid_off` (which triggers the gold moment on the linked goal, if any).

| Call | When |
|---|---|
| `GET /api/debts?lens` | mount |
| `GET /api/debts/payoff?strategy&extra` | mount, toggle, slider (debounced) |
| `GET /api/debts/compare?extra` | mount, slider settle |
| `POST /api/debts` · `PATCH /api/debts/:debtId` | add/edit |

### Investments
Plaid's investments product is **dormant** (needs production tier) — the portfolio is user-maintained through **manual positions**, so the editor is a first-class feature of this page, not a fallback.

- **Portfolio value chart** from `GET /api/portfolio/series?days=365`. The **Contributions vs. Growth** toggle refetches with `&decompose=true`: the single line splits into a stacked area (gray = contributions, green = market growth) with a smooth morph — the honest chart, one tap away. Performance stats (TWR/period returns) from `GET /api/portfolio/performance?days=365`.
- **Holdings table** from `GET /api/portfolio/holdings`: rows with 30-day sparklines, sortable; clicking a holding expands it in place to its full price history + buy points plotted as dots.
- **Positions editor** (the data source behind everything above): `GET /api/positions` returns positions grouped by account. An "Edit positions" mode turns rows editable — `POST /api/positions` / `PATCH /api/positions/:positionId` (full body: account, symbol *or* manualValue, assetType, quantity, bookCost) / `DELETE /api/positions/:positionId` (versioned — deletion end-dates, history stays). The symbol field validates as-you-type (debounced 400ms) against `GET /api/positions/validate/:symbol`, with a hint that TSX tickers need `.TO`. A **"Refresh prices"** button posts `POST /api/positions/refresh` — icon spins for the request (it pulls Yahoo closes and rebuilds snapshot history), then the series chart morphs to the corrected history.
- **Allocation**: `GET /api/portfolio/allocation` draws two concentric rings — outer = actual, inner = target. Drifted segments protrude 4px with an amber edge; hovering shows "+3.2% vs target". A "set targets" affordance edits the target weights inline → `PUT /api/portfolio/targets { assetClass: weight }` (weights 0–1). Ring sweeps on entrance.
- **Buildings & manual assets**: `GET /api/assets` lists manual assets (real estate, vehicles…); the Buildings card shows its valuation steps as a step-line with a **"Revalue"** affordance → `POST /api/assets/:assetId/valuations { date, value, source }`, drawing the new step live. Its mini P&L (rent − tagged expenses) comes from `GET /api/portfolio/buildings`. New manual assets via `POST /api/assets`.

| Call | When |
|---|---|
| `GET /api/portfolio/series?days&decompose` | mount, range preset, toggle |
| `GET /api/portfolio/holdings` · `GET /api/portfolio/performance?days` | mount |
| `GET /api/portfolio/allocation` · `PUT /api/portfolio/targets` | mount / target editor |
| `GET /api/positions` · `POST/PATCH/DELETE /api/positions*` | editor mode |
| `GET /api/positions/validate/:symbol` | symbol field (debounced) |
| `POST /api/positions/refresh` | refresh-prices button |
| `GET /api/assets` · `POST /api/assets` · `POST /api/assets/:assetId/valuations` | assets rail / revalue |
| `GET /api/portfolio/buildings?lens&month` | Buildings card |

### Net Worth
- **Full-history chart** from `GET /api/networth?days=365` (presets 3M/1Y/All map to `days`, max 3650): assets above the axis, debts mirrored below, net line threading through. On load, assets draw up and debts draw down simultaneously — the composition is the story. Milestone flags in gold (the response marks record highs).
- Hovering any point fetches `GET /api/networth/breakdown?date=YYYY-MM-DD` (cached per date, prefetched for the hovered neighborhood) and shows the full asset/debt account-level breakdown in a side panel that follows the crosshair.
- **Emergency-fund gauge** (new): `GET /api/networth/emergency-fund` renders a months-of-expenses dial against the household buffer target — quiet green when covered, amber when the runway dips below target.
- The page header's number reuses `GET /api/networth/hero` (same query the Overview hero warmed).

| Call | When |
|---|---|
| `GET /api/networth?days&lens` | mount, range change |
| `GET /api/networth/hero?lens` | header (usually cache-hit) |
| `GET /api/networth/breakdown?date` | crosshair hover (debounced + cached) |
| `GET /api/networth/emergency-fund?lens` | mount |

### Taxes
A **year selector** (defaults to the current year) threads `?year=` through every call on this page.

- Two person columns + combined header from `GET /api/tax/estimate?year`: estimated federal/QC tax, **marginal-rate arc gauge** (needle sweeps on load), and a **bracket glass** — income filling bracket tiers like liquid, the top tier only partly full, making "marginal rate" visible at a glance. Owing vs. refund rendered as a balance beam that tilts as the estimate updates through the year.
- **Inputs the estimate depends on** (new, essential): an "Assumptions" panel edits each person's tax profile — employment income, withholding paid, other income (interest, eligible dividends, capital gains, donations, medical) — via `GET /api/tax/profile?year` and `PUT /api/tax/profile`. Without real inputs the gauges are fiction; the panel shows an amber "using defaults" chip until a profile has been saved for the year.
- **Contribution room**: `GET /api/tax/room?year` shows FHSA/TFSA/RRSP room per person (used vs. available bars); a small editor writes CRA-statement numbers via `PUT /api/tax/room { rooms: [{personId, accountType, taxYear, roomAmount, source}] }`.
- **Optimizer panel**: room caps shown from the room query, plus one big slider for "cash to deploy". Dragging it posts `POST /api/tax/optimize { deployableCash, year }` (side-effect-free; throttled like the goals preview) — each response redistributes the FHSA/RRSP/TFSA allocation as animated stacked bars per person while "tax saved" and "projected refund" tick live. **Accept plan** posts `POST /api/tax/optimize/accept { deployableCash, year, planName }` → flies a summary card into the active plan (Goals page reflects it via `plans.*` invalidation).
- **Strategy cards** (new): `GET /api/tax/strategies?year` lists ranked moves beyond the slider (e.g. "FHSA first — deduction + tax-free withdrawal", spousal considerations) as expandable cards with estimated dollar impact.

| Call | When |
|---|---|
| `GET /api/tax/estimate?year&lens` | mount, year change |
| `GET/PUT /api/tax/profile?year` | assumptions panel |
| `GET/PUT /api/tax/room?year` | room section |
| `POST /api/tax/optimize` | slider drag (throttled) |
| `POST /api/tax/optimize/accept` | accept button |
| `GET /api/tax/strategies?year` | mount |

### Accounts & Connections
The front door of the whole system: link banks, choose accounts, and tell the platform what each one *means*. Also the first-run onboarding experience. **Every endpoint here is vault-gated** — when `GET /api/vault/status` reports locked, the page renders its cards from the last cached data with a full-width locked banner and disabled actions.

**Connections view**
- `GET /api/items` drives one card per institution (name, account count), a breathing sync dot (green < 24h, amber stale, red error with a "Reconnect" action when Plaid reports `ITEM_LOGIN_REQUIRED`), last-synced timestamp, and a "Sync now" button → `POST /api/items/:itemId/sync`, icon spinning while it runs — the response's new/updated transaction counts pop in as a small badge. A global "Sync all" uses `POST /api/sync`.
- Under each institution, its account rows from `GET /api/items/:itemId/accounts`: name + mask, balance (cached balances via `GET /api/balances?itemId`; a per-item "refresh balances" affordance hits `POST /api/accounts/:itemId/refresh` for live numbers), and **meaning chips** (owner, registered type, purpose). Hidden (`tracked: false`) accounts collapse into a "n hidden" footer row.
- A prominent **Add bank** card (dashed border, plus icon) sits at the end of the grid.

**Add-bank flow — a three-step wizard in a modal sheet**
The sheet has a slim progress rail (Connect → Select → Classify); steps slide horizontally, the rail's fill animating between them.

1. **Connect.** Clicking Add bank calls `POST /api/link/token { clientUserId }` and opens the Plaid Link SDK overlay (Plaid owns this UI — credentials never touch ours). While Link is open our sheet dims and waits; on success we exchange the public token (`POST /api/link/exchange { publicToken }`), and the wizard advances with the institution's name sliding in as confirmation.
2. **Select.** The wizard calls `POST /api/items/:itemId/accounts/refresh` to pull the item's full account list from Plaid, then renders the rows **staggering in top-to-bottom** (60ms), each with Plaid's name, mask, type/subtype badge, and current balance ticking up from 0. Every row has a toggle, defaulted ON for depository/investment/credit accounts and OFF for anything already linked elsewhere (duplicate detection by mask + institution — a gray "already tracked" chip explains itself). Toggling OFF fades the row to 40% opacity and will be persisted as `tracked: false` in step 3. A footer live-counts "4 accounts will be tracked."
3. **Classify.** The selected accounts re-present as **classification cards**, one at a time (same card-stack pattern as the uncategorized inbox — keyboard-first, number keys work). Each card collects a patch for `PATCH /api/accounts/:accountId`:
   - **Whose is it?** — segmented pill: Nick / Shanthi / Joint (`personId`, null = joint; persons from `GET /api/persons`).
   - **What is it?** — smart-defaulted from Plaid type/subtype, shown as a chip row the user confirms or corrects: *Spending · Savings · FHSA · TFSA · RRSP · Non-registered investing · Credit card · Loan/LOC* (`registeredType`; e.g. subtype `tfsa` → TFSA pre-selected, glowing softly to say "we guessed this").
   - **Purpose (optional)** — free-tag with suggestions: Emergency fund, Vacation sinking fund, House down payment, Bills account (`purpose`). Purpose tags are what let the Goals engine auto-link (an account tagged for the house goal starts counting toward its ring immediately).
   - For **credit/loan accounts**, one extra inline question: "Track as a debt?" → `POST /api/debts` with APR and minimum-payment fields right there, so the payoff mountain knows about it from day one.
   Confirming a card fires the PATCH and flies it off-stack; the last card's confirm becomes **Finish** — the sheet closes with the new institution card *landing* into the Connections grid (shared-element), its sync dot already pulsing as `POST /api/items/:itemId/sync` kicks off the first historical pull in the background. A toast reports "Pulling up to 24 months of history — charts will fill in as it lands," and global invalidation runs when it resolves.

**Editing later**
- Meaning chips on any account row are always editable in place (click → the same segmented controls inline, no wizard) → `PATCH /api/accounts/:accountId`. Changing owner or registered type takes effect from now and prompts once: "Reclassify past data too?" — explicit, because it rewrites history in every chart (and triggers the invalidate-everything path). Closing an account sets `isClosed`.
- Unlinking an institution requires typing its name (destructive: `DELETE /api/items/:itemId` revokes at Plaid and deletes local rows), with a clear note about what's kept (nothing) vs. what a re-link restores (everything Plaid still has).

**First run**
On an empty database the app boots straight into this page in onboarding mode: a two-up hero ("Link your first bank" / "Set up your household") that walks through persons, base currency, buffer target (`PUT /api/settings`), then loops the add-bank wizard until both of you have linked everything. The Overview page stays locked (grayed nav with a "2 accounts linked — keep going" hint) until at least one account is classified, so the first real render of the dashboard is never empty. *(Note: person creation has no API yet — see §9; until it exists, persons come from the seed.)*

### Monthly Review (money date)
- **Story mode**: `GET /api/review/:month` returns the deck — big-number slides (What came in → Where it went → Variances worth discussing → Goals → Decisions) rendered as a full-screen guided stepper, advanced with arrow keys/taps, each slide's figures animating in. Designed to cast to a TV or prop a tablet on the table. Slides reuse the chart builders (sankey slide, variance bars) so the grammar carries over.
- Ends on a **Decision capture** slide: type decisions, each saves via `POST /api/decisions { date, title, body }` with the month stamped; the running decision log (shown on entry to remind you of last month's calls) reads `GET /api/decisions`.
- **Archive & shelf**: "Archive this review" posts `POST /api/reports/monthly/:month/generate`; past months are flippable from a shelf view fed by `GET /api/reports?type=monthly`, each opening via `GET /api/reports/:reportId` — archived reports are frozen snapshots, so they render instantly and never change under you.

| Call | When |
|---|---|
| `GET /api/review/:month` | entering story mode |
| `POST /api/decisions` · `GET /api/decisions` | decision slide |
| `POST /api/reports/monthly/:month/generate` | archive action |
| `GET /api/reports?type=monthly` · `GET /api/reports/:reportId` | shelf |

### Settings
Small page, pinned next to Accounts in the sidebar.

- **Household numbers**: `GET /api/settings` / `PUT /api/settings` — `buffer_floor` and `buffer_target` (the cash cushion the bills ribbon and the goals solver respect) and `base_currency`. Editing either buffer invalidates everything (it changes projections and solves).
- **Theme** (local), keyboard-shortcut cheatsheet, and the **data & jobs** block: last nightly run status (from `overview.lastSync`), a "Run nightly now" button → `POST /api/jobs/nightly/run` (spinner for the duration; the response summarizes each pipeline step — sync, fx, snapshots, categorize, recurring match, alerts — shown as a checklist that ticks green), and vault status (`GET /api/vault/status`) with session expiry countdown.

## 7. Micro-interactions & polish
- Buttons compress to 98% scale on press; primary actions fill with `--accent` and release a 1px ring on success.
- Toasts slide up bottom-center, auto-dismiss, undo where destructive. Mutation toasts carry payload facts ("Rule saved — 12 past transactions updated").
- Currency: narrow no-break space thousands separators, cents de-emphasized at 70% opacity on figures ≥ $1,000.
- Empty states: single-line copy + a faint illustration in `--surface-2`, one primary action ("Link an account", "Set your first budget").
- Skeletons mirror final layout (card + sparkline ghost) with a slow shimmer; charts never pop in after content — axes reserve the space.
- Theme toggle morphs sun↔moon and cross-fades tokens over 300ms; respects OS setting by default.
- **Error states**: a failed engine query renders an inline retry card, never a blank chart; a 503 from a Plaid route renders the vault-locked state, not an error.

## 8. Accessibility
- WCAG AA contrast in both themes (the muted grays are tuned for it); color never the sole signal (glyphs + labels accompany green/red).
- Full keyboard coverage: lens = `[`/`]`, month = `,`/`.`, palette = ⌘K, charts expose their data as accessible tables behind a "view data" affordance.
- `prefers-reduced-motion` honored globally (§5.6).
- Touch targets ≥ 44px on tablet/phone layouts.

## 9. Backend gaps the frontend surfaces

Things the current API cannot do that the design above assumes — each needs a small server change (or a stated workaround):

1. **Auth (PIN → session cookie)** — no login endpoint exists. Until it does, the app trusts the LAN. The client should isolate auth in one fetch-layer interceptor so adding it later is a one-file change.
2. ~~`GET /api/persons` is vault-guarded~~ — **fixed**: moved to a DB-only `personsRouter` mounted with the engine routes.
3. ~~No person-creation API~~ — **fixed**: `POST /api/persons` (upsert) exists; the onboarding wizard uses it.
4. **Transaction search** — `GET /api/transactions` filters only by date/account/item. The ⌘K "costco march" search needs a `q=` param (or the palette filters a cached recent window client-side).
5. **Full-body PATCHes** — `PATCH /api/bills/:rpId` and `PATCH /api/positions/:positionId` validate the complete create schema, not a partial; edit forms must round-trip every field. (Fine, just a form-design constraint worth knowing.)
6. **Plaid `ITEM_LOGIN_REQUIRED` re-link** — the Connections card promises a "Reconnect" action, which needs Link update-mode (a link token created with the existing access token). Not exposed yet; needs a `POST /api/items/:itemId/relink-token` or a mode flag on `/api/link/token`.
7. **Report/alert payload for the sync badge** — per-item sync responses carry counts (used for the badge); nothing streams progress for the long first historical pull. Acceptable: the toast sets expectations and global invalidation catches the data when it lands.

## 10. Endpoint inventory (every route, mapped)

Engine tier (always available, all accept `?lens&month` or `?from&to` where meaningful):

| Endpoint | Page(s) |
|---|---|
| `GET /api/overview` | Overview |
| `GET /api/cashflow/summary` · `/sankey` · `/flux?months` · `/category/:categoryId` · `/excluded` | Cash Flow (summary shared with Overview zoom); excluded feeds the Budget "not counted" card |
| `GET /api/budget` · `/variances` · `/versions` · `PUT /api/budget/lines` | Budget |
| `GET/POST /api/categories` · `GET/POST /api/categories/rules` · `DELETE /api/categories/rules/:ruleId` · `GET /api/categories/inbox` · `POST /api/transactions/:id/categorize` · `PATCH /api/transactions/:id/flags` | Budget (inbox + manage; flags = work-reimbursed / goal spending, excluded from the budget) |
| `GET /api/bills/calendar` · `/registry?status` · `/renewals?days` · `POST /api/bills` · `PATCH/DELETE /api/bills/:rpId` · `POST /api/bills/:rpId/accept` · `/dismiss` | Bills |
| `GET /api/debts` · `/payoff?strategy&extra` · `/compare?extra` · `POST /api/debts` · `PATCH /api/debts/:debtId` | Debt (+POST from Accounts wizard) |
| `GET /api/networth` · `/hero` · `/breakdown?date` · `/emergency-fund` | Net Worth, Overview hero |
| `GET /api/portfolio/series?days&decompose` · `/holdings` · `/allocation` · `/performance?days` · `/buildings` · `PUT /api/portfolio/targets` | Investments |
| `GET/POST /api/positions` · `PATCH/DELETE /api/positions/:positionId` · `POST /api/positions/refresh` · `GET /api/positions/validate/:symbol` | Investments (editor) |
| `GET/POST /api/assets` · `POST /api/assets/:assetId/valuations` | Investments (manual assets) |
| `GET/POST /api/goals` · `PATCH /api/goals/:goalId` · `POST /api/goals/:goalId/items` · `DELETE /api/goals/items/:lineId` · `POST /api/goals/solve` · `/solve/preview` | Goals |
| `POST /api/plans/approve` · `GET /api/plans/active` | Goals, Taxes (accept) |
| `GET/POST /api/scenarios` · `DELETE /api/scenarios/:scenarioId` · `POST /api/scenarios/:scenarioId/solve` | Goals (compare) |
| `GET /api/tax/estimate?year` · `/strategies?year` · `GET/PUT /api/tax/room` · `GET/PUT /api/tax/profile` · `POST /api/tax/optimize` · `/optimize/accept` | Taxes |
| `GET /api/alerts` · `POST /api/alerts/:alertId/ack` | Bell (shell), Overview |
| `GET /api/reports?type` · `GET /api/reports/:reportId` · `POST /api/reports/monthly/:month/generate` · `GET /api/review/:month` | Review |
| `GET /api/decisions` · `POST /api/decisions` | Review |
| `GET/PUT /api/settings` · `POST /api/jobs/nightly/run` | Settings, onboarding |
| `GET /api/vault/status` · `GET /healthz` | Shell (VaultBanner, sync dot) |

Plaid tier (503 when the vault is locked — Accounts page + palette search only):

| Endpoint | Page(s) |
|---|---|
| `POST /api/link/token` · `POST /api/link/exchange` | Accounts (wizard step 1) |
| `GET /api/items` · `DELETE /api/items/:itemId` | Accounts |
| `GET /api/persons` | lens switch (cached, see §9.2) |
| `GET /api/items/:itemId/accounts` · `POST /api/items/:itemId/accounts/refresh` · `PATCH /api/accounts/:accountId` | Accounts (wizard steps 2–3, chip editing) |
| `POST /api/items/:itemId/sync` · `POST /api/sync` | Accounts (sync buttons) |
| `GET /api/transactions` | ⌘K search |
| `GET /api/balances?itemId` · `POST /api/accounts/:itemId/refresh` | Accounts (balances) |

## 11. Build order (maps to roadmap phases)
1. **Shell + data layer** (Phase 2): tokens, sidebar/topbar, lens + month Zustand stores, typed API client over `@contracts`, query-key scheme + invalidation map, vault-status banner, page transitions, **Accounts & Connections page + onboarding wizard** (it gates everything — data can't be classified without it), Overview with live KPIs (`/api/overview`).
2. **Cash Flow + Budget pages** (Phase 2): sankey, flux matrix, drilldown drawer, budget bars + versioned editor, inbox + rules.
3. **Bills + Debt** (Phase 3): calendar + ribbon, registry + proposed tray + renewals, payoff mountain + compare + extra slider.
4. **Goals** (Phase 4): timeline with drag-to-replan (`solve/preview` loop), line items, plan approval, scenario compare.
5. **Investments + Net Worth** (Phase 5): portfolio charts + decompose toggle, positions editor + price refresh, allocation rings + targets, manual assets/revalue, mirrored net-worth chart + breakdown panel + emergency-fund gauge.
6. **Taxes** (Phase 6): estimate gauges + bracket glasses, profile & room editors, optimizer slider + accept, strategy cards.
7. **Review story mode + decisions + report shelf + alerts + Settings + polish** (Phase 7).
