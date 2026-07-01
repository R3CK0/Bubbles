# Frontend Design — "Sage & Slate"

*Companion to [PLATFORM_PROPOSAL.md](PLATFORM_PROPOSAL.md) and [DATA_MODEL.md](DATA_MODEL.md). Defines the visual language, navigation, and interaction/animation behavior of the dashboard.*

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

Served by the existing Express app on the LAN; in dev, Vite proxies `/api/*` to `:4000`. Auth: shared household PIN → session cookie (it's two users at home; the YubiKey continues to guard the *server*, the PIN guards the *screen*).

## 3. Navigation & shell

### Layout
- **Left sidebar**, 232px, collapsible to a 64px icon rail (state remembered). Sections: Overview · Cash Flow · Budget · Bills · Goals · Debt · Investments · Net Worth · Taxes · Review, with **Accounts** pinned at the bottom next to Settings. The active item carries a pill highlight that **slides** between items (Framer `layoutId`) rather than blinking from one to the next.
- **Top bar**: three controls, global to every page —
  1. **Person lens** — segmented pill `Nick | Shanthi | Both`. Switching does not reload: every figure on screen *rolls* to its new value (odometer ticker, 400ms), charts morph their series in place. The lens is the single most-used control, so it must feel instant.
  2. **Month scrubber** — current month with ‹ › steppers; click opens a horizontal 12-month strip you can drag/scrub, and every chart follows the scrub live (throttled to animation frames).
  3. **Sync + alerts** — a small dot that breathes green when last sync < 24h (amber when stale), and a bell whose badge increments with a little spring pop.
- **Command palette** (⌘K): jump to any page, search transactions ("costco march"), or run quick actions ("add goal", "recategorize"). Fastest path for power use.
- **Tablet/phone** (couch use): sidebar becomes a bottom tab bar with the 5 core pages + "More" sheet; charts switch to touch scrubbing.

### Page transitions
Crossfade + 12px vertical slide, 250ms ease-out, content staggering in top-to-bottom (60ms between rows). Where a navigation is a *zoom-in* (card → its page, transaction row → detail), a **shared-element transition** carries the element: the KPI card's sparkline expands into the full chart on the destination page — the axes fade in around it, so continuity is literal, not implied.

## 4. Chart behavior (the signature of the app)

Charts follow one grammar everywhere:

1. **Entrance**: axes and gridlines fade in first (150ms), then the data **draws** — lines sweep left→right (~900ms ease-out) with their gradient area fading up behind (green above zero, gray below); bars grow from the baseline with a 25ms stagger; donuts sweep clockwise from 12 o'clock; heatmap cells fade in as a diagonal wave.
2. **State change ≠ redraw**: change the lens, the month, or a toggle, and existing series **morph** to their new geometry (ECharts `animationDurationUpdate: 600`). You watch March become April; nothing flashes.
3. **Hover**: a thin vertical crosshair snaps to the nearest data point (magnetic), the point blooms a soft halo, and a tooltip follows with date + values in tabular figures. On multi-series charts the tooltip lists all series sorted by value.
4. **Scrub & brush**: press-drag on any time chart selects a range; on release, a floating stats chip springs up (Δ, %, avg/mo for the selection) with "Zoom to range" — zooming animates the axes rescaling. Double-click resets, animated back.
5. **Expand**: every chart card has an expand affordance (and responds to click-anywhere-on-mini-charts). Expansion is a FLIP transition into a **full-screen detail view**: the mini chart *is* the big chart, growing in place while controls dock around it — range presets (3M/1Y/All), granularity (day/week/month), compare toggle (vs. last year / vs. budget / Nick-vs-Shanthi dual line), and an "explain" panel listing the underlying rows. Esc or a pinch-shrink returns it, reversing the FLIP.
6. **Reduced motion**: `prefers-reduced-motion` swaps every draw/morph for a 150ms fade and kills the ambient background — same information, no theatre.
7. **Performance rule**: only `transform`/`opacity` animate in DOM; series animation stays on ECharts' canvas; transaction tables virtualize past 100 rows. 60fps or the animation gets cut.

## 5. Page-by-page

### Overview (home)
The answer to "how are we doing?" in five seconds.
- **Hero**: combined net worth, 48px, ticking up from its previous session value on load (900ms odometer) with a ▲ monthly delta chip; behind it a 90-day area sparkline draws in. A gold milestone flag plants itself on the line when a record is crossed.
- **Four KPI cards** (Money in · Money out · Remaining this month · Invested), each with a sparkline; cards raise 2px on hover, click zooms (shared element) into their page.
- **Goal strip**: horizontally scrollable ring cards, rings sweeping to their fill on mount, staggered 80ms.
- **Next 7 days**: compact bill list; each row's due-date dot pulses once amber if the projected balance dips low that day.
- **Alert cards** slide in from the right edge, stack, and settle; dismissing swipes them away with a spring.

### Cash Flow
- **Sankey diagram** as the centerpiece: Income streams (Nick / Shanthi / Buildings) flow left→right through "Household" into category branches. On load, flows *pour* — link opacity and width animate in over 1.2s like liquid finding channels. Hovering a link dims everything else and shows the amount; **clicking a category node splits it in place** into its subcategories, the sankey reflowing around it with a smooth relayout. Lens switch re-pours only the affected streams.
- **Flux matrix** (the Excel table, alive): 12-month × category heatmap, green-tinted under budget / amber over; cells fade in diagonally. Click a cell → a right-side **drawer** slides in with that month-category's transactions, mini trend, and variance narrative.

### Budget
- Category rows, each with a **dual-bar**: gray track = budget, green fill = actual, animating to width on mount. Overspend renders the overflow as an amber cap that pulses *once*. Variance chip (▲$142) sits right-aligned.
- Rows **expand accordion-style** (height spring, content fade) into subcategory bars + a 6-month mini trend + "set budget" inline editor — adjusting the number live-updates the "Remaining" figure in the page header with a ticker.
- **Uncategorized inbox**: a focused card stack — one transaction at a time, big merchant name, suggested category as the primary button. Keyboard-first: number keys pick categories, the card flies off to the left and the next springs up. Clearing the stack earns a brief all-clear state with the stack folding away.

### Bills & Recurring
- **Month calendar** with amount dots; below it, the **projected balance ribbon** — an area chart of expected balance across the month. Hovering a calendar day drops a plumb line onto the ribbon; days where the ribbon dips under the buffer glow amber. Payday bumps are visible as steps.
- The registry table shows each bill with next-due countdown and a price-history sparkline; a **price-creep badge** (▲ $2.40 since Jan) sits on offenders. "Proposed" auto-detected bills arrive in a tray at top with accept/dismiss — accepting animates the row flying into its slot in the table.

### Goals & Planning
- **Timeline view**: horizontal time axis (now → +5y), goals as rounded bars with progress fill. **Drag a goal's target date** and the affordability solver re-runs live: each goal's feasibility chip (green ✓ / amber ~ / red ✕) springs to its new state and the "required monthly" figures tick as you drag. Collisions (months where demands exceed free cash flow) shade the timeline background red-gray in real time. This one interaction *is* the planning experience.
- Goal cards carry progress rings; funding events ripple a soft green glow outward. Completing a goal draws the checkmark and bursts the ring once in `--gold` — the app's single celebratory moment.
- **Scenario compare**: side-by-side world A/B with a draggable center divider; both timelines scrub together.

### Debt
- **Payoff mountain**: stacked balance area melting toward zero. The avalanche/snowball toggle **morphs the curves** between strategies while a chip states the difference ("Avalanche: debt-free 4 months sooner, $3,214 less interest"). Scrubbing shows per-debt balances at any future date.
- Debt-free countdown in the header ticks monthly; interest-saved-to-date accumulates in green.

### Investments
- Portfolio value chart with a **Contributions vs. Growth** toggle: the single line splits into a stacked area (gray = contributions, green = market growth) with a smooth morph — the honest chart, one tap away.
- Holdings table: rows with 30-day sparklines, sortable; clicking a holding expands it in place to its full price history + your buy points plotted as dots.
- **Allocation**: two concentric rings — outer = actual, inner = target. Drifted segments protrude 4px with an amber edge; hovering shows "+3.2% vs target". Ring sweeps on entrance.
- Buildings (manual asset) shows its valuation steps as a step-line with a "revalue" affordance; its mini P&L (rent − tagged expenses) sits alongside.

### Net Worth
- Full-history chart, **assets above the axis, debts mirrored below**, net line threading through. On load, assets draw up and debts draw down simultaneously — the composition is the story. Milestone flags in gold; hovering any point shows the full asset/debt breakdown for that day in a side panel that follows the crosshair.

### Taxes
- Two person columns + combined header. Each column: estimated tax, **marginal-rate arc gauge** (needle sweeps on load), and a **bracket glass** — your income filling bracket tiers like liquid, the top tier only partly full, making "marginal rate" visible at a glance.
- **Optimizer panel**: three inputs (buffer to keep, goals locked toggle, room caps shown) and one big slider for "cash to deploy". Dragging it redistributes FHSA/RRSP/TFSA allocations as animated stacked bars per person, while "tax saved" and "projected refund" tick live. An **Accept plan** button commits it → flies a summary card into the active plan (and the Goals page reflects it).
- Owing vs. refund rendered as a balance beam that tilts as the estimate updates through the year.

### Accounts & Connections
The front door of the whole system: link banks, choose accounts, and tell the platform what each one *means*. Also the first-run onboarding experience.

**Connections view**
- One card per institution (logo, name, account count), a breathing sync dot (green < 24h, amber stale, red error with a "Reconnect" action when Plaid reports `ITEM_LOGIN_REQUIRED`), last-synced timestamp, and a "Sync now" button whose icon spins while `/api/items/:id/sync` runs — new-transaction count pops in as a small badge when it lands.
- Under each institution, its account rows: name + mask, balance, and **meaning chips** (owner, registered type, purpose — see below). Hidden accounts collapse into a "n hidden" footer row.
- A prominent **Add bank** card (dashed border, plus icon) sits at the end of the grid.

**Add-bank flow — a three-step wizard in a modal sheet**
The sheet has a slim progress rail (Connect → Select → Classify); steps slide horizontally, the rail's fill animating between them.

1. **Connect.** Clicking Add bank calls `POST /api/link/token` and opens the Plaid Link SDK overlay (Plaid owns this UI — credentials never touch ours). While Link is open our sheet dims and waits; on success we exchange the public token (`POST /api/link/exchange`), and the wizard advances with the institution's name and logo sliding in as confirmation.
2. **Select.** The just-linked item's accounts are fetched and appear as rows **staggering in top-to-bottom** (60ms), each with Plaid's name, mask, type/subtype badge, and current balance ticking up from 0. Every row has a toggle, defaulted ON for depository/investment/credit accounts and OFF for anything already linked elsewhere (duplicate detection by mask + institution — a gray "already tracked" chip explains itself). Toggling OFF fades the row to 40% opacity. A footer live-counts "4 accounts will be tracked."
3. **Classify.** The selected accounts re-present as **classification cards**, one at a time (same card-stack pattern as the uncategorized inbox — keyboard-first, number keys work). Each card asks, in order:
   - **Whose is it?** — segmented pill: Nick / Shanthi / Joint (pre-filled from the item's owner, one tap to change).
   - **What is it?** — smart-defaulted from Plaid type/subtype, shown as a chip row the user confirms or corrects: *Spending · Savings · FHSA · TFSA · RRSP · Non-registered investing · Credit card · Loan/LOC*. Plaid subtypes map straight onto these (e.g. subtype `tfsa` → TFSA pre-selected, glowing softly to say "we guessed this").
   - **Purpose (optional)** — free-tag with suggestions: Emergency fund, Vacation sinking fund, House down payment, Bills account. Purpose tags are what let the Goals engine auto-link (an account tagged for the house goal starts counting toward its ring immediately).
   - For **credit/loan accounts**, one extra inline question: "Track as a debt?" → creates the `debts` row with APR and minimum-payment fields right there, so the payoff mountain knows about it from day one.
   Confirming a card flies it off-stack; the last card's confirm becomes **Finish** — the sheet closes with the new institution card *landing* into the Connections grid (shared-element), its sync dot already pulsing as the first historical sync kicks off in the background. A toast reports "Pulling up to 24 months of history — charts will fill in as it lands."

**Editing later**
- Meaning chips on any account row are always editable in place (click → the same segmented controls inline, no wizard). Changing owner or registered type takes effect from now and prompts once: "Reclassify past data too?" — explicit, because it rewrites history in every chart.
- Unlinking an institution requires typing its name (destructive: revokes at Plaid and deletes local rows per the existing `DELETE /api/items/:id`), with a clear note about what's kept (nothing) vs. what a re-link restores (everything Plaid still has).

**Backend additions this page needs** (small): `GET /api/items/:itemId/accounts` (post-exchange fetch for the Select step), `PATCH /api/accounts/:accountId` (owner / registered type / purpose / tracked — writes `classified_at`), and `POST /api/debts` (inline debt creation for credit/loan accounts). Everything else reuses the existing link/exchange/sync/delete routes.

**First run**
On an empty database the app boots straight into this page in onboarding mode: a two-up hero ("Link your first bank" / "Set up your household") that walks through persons, base currency, buffer target, then loops the add-bank wizard until both of you have linked everything. The Overview page stays locked (grayed nav with a "2 accounts linked — keep going" hint) until at least one account is classified, so the first real render of the dashboard is never empty.

### Monthly Review (money date)
- **Story mode**: full-screen guided stepper — big-number slides (What came in → Where it went → Variances worth discussing → Goals → Decisions), advanced with arrow keys/taps, each slide's figures animating in. Designed to cast to a TV or prop a tablet on the table.
- Ends on a **Decision capture** slide: type decisions, they save to the decision log with the month stamped. The report archives itself; past months are flippable from a shelf view.

## 6. Micro-interactions & polish
- Buttons compress to 98% scale on press; primary actions fill with `--accent` and release a 1px ring on success.
- Toasts slide up bottom-center, auto-dismiss, undo where destructive.
- Currency: narrow no-break space thousands separators, cents de-emphasized at 70% opacity on figures ≥ $1,000.
- Empty states: single-line copy + a faint illustration in `--surface-2`, one primary action ("Link an account", "Set your first budget").
- Skeletons mirror final layout (card + sparkline ghost) with a slow shimmer; charts never pop in after content — axes reserve the space.
- Theme toggle morphs sun↔moon and cross-fades tokens over 300ms; respects OS setting by default.

## 7. Accessibility
- WCAG AA contrast in both themes (the muted grays are tuned for it); color never the sole signal (glyphs + labels accompany green/red).
- Full keyboard coverage: lens = `[`/`]`, month = `,`/`.`, palette = ⌘K, charts expose their data as accessible tables behind a "view data" affordance.
- `prefers-reduced-motion` honored globally (§4.6).
- Touch targets ≥ 44px on tablet/phone layouts.

## 8. Build order (maps to roadmap phases)
1. **Shell** (Phase 2): tokens, sidebar/topbar, lens + month state, page transitions, **Accounts & Connections page + onboarding wizard** (it gates everything — data can't be classified without it), Overview with live KPIs.
2. **Cash Flow + Budget pages** (Phase 2): sankey, flux matrix, budget bars, inbox.
3. **Bills + Debt** (Phase 3): calendar + ribbon, registry, payoff mountain.
4. **Goals** (Phase 4): timeline with drag-to-replan, scenario compare.
5. **Investments + Net Worth** (Phase 5): portfolio charts, allocation rings, mirrored net-worth chart.
6. **Taxes** (Phase 6): gauges, bracket glasses, optimizer panel.
7. **Review story mode + alerts + polish** (Phase 7).
