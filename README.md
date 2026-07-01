# Finances backend

Local-first backend service that links bank accounts through Plaid and syncs
balances/transactions into a local SQLite database. All Plaid API keys and
per-bank access tokens are stored in an encrypted vault that can only be
decrypted with a physical YubiKey.

The SQLite schema is defined as a numbered migration chain in
[`src/db/migrations/`](src/db/migrations), applied automatically on boot and
tracked in a `schema_migrations` table (see `docs/DATA_MODEL.md` for the full
design). It covers banking (items/accounts/transactions), categories/budgets,
recurring payments/debts, goals/plans, investments, registered accounts/tax,
and operational tables (alerts/reports/decisions/sync runs) — schema only for
now; the analytics engine and API surface for these domains come in a later
pass.

## How the vault works

- Secrets (`data/vault/secrets.age`) are encrypted with [`age`](https://github.com/FiloSottile/age)
  to a recipient backed by your YubiKey's PIV applet, via
  [`age-plugin-yubikey`](https://github.com/str4d/age-plugin-yubikey). Decrypting
  requires the physical key to be inserted, your PIV PIN, and a touch.
- Nothing about this scheme is custom cryptography — we shell out to those two
  audited tools for every encrypt/decrypt operation.
- **Session grants** let the server run unattended for up to 30 days: running
  `vault grant-session` unlocks the vault with your YubiKey once, then seals
  the secrets with a freshly generated random key stored in the macOS
  Keychain (with expiry metadata enforced in code). When it expires, the
  server refuses to start until you touch the YubiKey again — either via a
  direct unlock at boot, or by re-running `grant-session`.

## Prerequisites

```bash
brew install age age-plugin-yubikey
npm install
```

You'll need a YubiKey with a free PIV slot (a factory-default key works out of
the box — `age-plugin-yubikey --generate` will provision one for you).

## One-time setup

1. **Provision the vault** (insert your YubiKey first):

   ```bash
   npm run vault -- init
   ```

   This generates a new PIV identity on the key (or pass `--existing-identity`
   / `--existing-recipient` to reuse one you already provisioned) and creates
   an empty encrypted secrets file at `data/vault/secrets.age`.

2. **Store your Plaid API keys** (requires touching the YubiKey again — this
   is the only place Plaid credentials are ever written to disk):

   ```bash
   npm run vault -- set-plaid-keys --client-id <id> --secret <secret> --env sandbox
   ```

3. **Build and run:**

   ```bash
   npm run dev      # ts-node style dev server with reload
   # or
   npm run build && npm start
   ```

   On boot the server first looks for a valid session grant; if there isn't
   one, it falls back to an interactive YubiKey unlock (touch required) right
   there in the terminal.

4. **Link a bank (Sandbox).** With the dev server running, open
   `http://127.0.0.1:4000/link-test.html` — a minimal test harness (not part
   of the real app) that drives Plaid Link end-to-end: creates a link token,
   opens Plaid's hosted Link flow, and exchanges the resulting `public_token`
   through the backend. In Sandbox, use Plaid's test credentials
   (`user_good` / `pass_good`) to simulate a bank login.

## Running unattended for up to 30 days

```bash
npm run vault -- grant-session --days 30   # requires the YubiKey once
npm run vault -- status                    # check remaining validity
npm run vault -- revoke-session            # kill the grant early
```

The service enforces the 30-day cap in code regardless of what's requested.
When a grant expires, restart the server with the YubiKey present, or run
`grant-session` again — there is no way to extend a grant without a fresh
YubiKey touch.

## Docker deployment

This service (and any others added later) deploys via `docker compose`:

```bash
docker compose build
docker compose up -d
```

**The vault CLI still runs on the host, never in the container.** Docker
Desktop can't pass a physical YubiKey's USB/PC-SC access through to a Linux
container, so the split is:

- **Host** (bare `npm run vault -- ...`, per the setup steps above): the only
  place that ever touches the physical key — `init`, `set-plaid-keys`, and
  `grant-session`/its 30-day refresh all happen here.
- **Container**: only ever consumes an existing session grant. It has `age`
  and `age-plugin-yubikey` installed and a `pcscd` daemon running internally
  (see `docker/entrypoint.sh`), but that's only so the plugin can do
  recipient-only *encryption* (e.g. re-sealing the vault when a new bank gets
  linked through the running API) — that's pure public-key wrapping and
  genuinely doesn't need the physical key present. *Decrypting* the vault
  always needs the real hardware, so if the container ever boots with no
  valid session grant, it will try and fail fast with a clear error in
  `docker compose logs` telling you to refresh one from the host.

Both host and container read/write the same `./data` directory — it's a bind
mount (`./data:/app/data` in `docker-compose.yml`), not a Docker-managed
volume, specifically so the host-run vault CLI and the containerized server
see identical files.

Practical loop:

```bash
npm run vault -- init                                         # host, YubiKey required, once
npm run vault -- set-plaid-keys --client-id ... --secret ...   # host, YubiKey required
npm run vault -- grant-session --days 30                       # host, YubiKey required, every ≤30 days
docker compose up -d                                           # container just serves the API
```

The API is published to `127.0.0.1:4000` only (not all interfaces), matching
the "local only" posture of the non-Docker setup.

## API

All routes except `/healthz` and `/api/vault/status` return `503` if the
vault isn't unlocked in the running process.

| Method | Path | Description |
|---|---|---|
| GET  | `/healthz` | Liveness check |
| GET  | `/api/vault/status` | Vault init / session-grant status (no secrets) |
| POST | `/api/link/token` | `{ clientUserId }` → creates a Plaid Link token |
| POST | `/api/link/exchange` | `{ publicToken }` → exchanges for an access token, stores it in the vault, links the bank, and auto-fetches its accounts (`{ …, accountsFetched }`) |
| GET  | `/api/items` | List linked banks (metadata only) |
| DELETE | `/api/items/:itemId` | Unlink a bank (revokes with Plaid, deletes local data) |
| GET  | `/api/persons` | Household persons (for assigning account ownership in the classify wizard) |
| GET  | `/api/items/:itemId/accounts` | List that item's accounts with their classification state |
| POST | `/api/items/:itemId/accounts/refresh` | Re-pull the item's accounts from Plaid (upsert; keeps existing classifications) |
| PATCH | `/api/accounts/:accountId` | Classify one account: `{ personId?, registeredType?, purpose?, tracked?, isClosed? }` |
| POST | `/api/items/:itemId/sync` | Incremental transaction sync for one bank (Plaid `/transactions/sync`, cursor-based — only pulls what changed since the last sync) |
| POST | `/api/sync` | Incremental sync across every linked bank |
| GET  | `/api/transactions?startDate&endDate&accountId&itemId&limit&offset` | Query locally-synced transactions in a date range |
| GET  | `/api/balances?itemId` | Cached local balances |
| POST | `/api/accounts/:itemId/refresh` | Live balance pull from Plaid, refreshes the cache |

### Adding a bank and classifying its accounts

Linking a bank now populates its accounts automatically, so the flow is:

1. `POST /api/link/token` → Plaid Link UI → `POST /api/link/exchange`. The
   exchange links the bank **and** fetches its accounts in one step (they land
   `tracked` but *unclassified* — `classifiedAt: null`).
2. `GET /api/items/:itemId/accounts` to show the user what came back (name,
   mask, type, balance). `GET /api/persons` gives the owner options.
3. For each account, `PATCH /api/accounts/:accountId` to record what it is
   (`personId` — omit/`null` for joint, `registeredType` FHSA/TFSA/RRSP/RESP/
   NONREG, freeform `purpose`) and whether to keep it in analytics
   (`tracked: false` keeps it synced/listed but excludes it from every
   downstream number). This stamps `classifiedAt`, which onboarding gates on.

Accounts exist before you sync, so `POST /api/items/:itemId/sync` no longer
depends on a manual balance refresh first.

An account's classification (`personId`, `registeredType`, `purpose`,
`tracked`, `isClosed`) is never overwritten by a later balance refresh or
account re-fetch — only Plaid-owned balance/metadata fields update.

### Transaction shape

Each transaction returned by `/api/transactions` includes at minimum:

```jsonc
{
  "transactionId": "...",
  "accountId": "...",
  "amount": 42.10,
  "currency": "USD",
  "date": "2026-06-30",
  "type": "in store",       // Plaid payment_channel: online / in store / other
  "paidTo": "Whole Foods",  // merchant_name, falling back to the raw description
  "category": { "primary": "FOOD_AND_DRINK", "detailed": "FOOD_AND_DRINK_GROCERIES" },
  "pending": false
}
```

## Configuration

Copy `.env.example` to `.env` for local overrides (port, host, Plaid
products/country codes). None of these values are secret — only `PORT`,
`HOST`, and similar runtime knobs. Load it however you like, e.g.:

```bash
set -a; source .env; set +a; npm run dev
```

## Data storage

Everything lives under `./data` (gitignored): the SQLite DB
(`finances.db`), the encrypted vault, and session-grant material. Nothing is
sent anywhere except to Plaid's API itself.

`./data` is a real directory on disk, not an ephemeral container filesystem —
under Docker Compose it's bind-mounted (`./data:/app/data`), so the database
and vault survive container restarts/recreates. SQLite runs in WAL mode, so a
clean shutdown (or the next open, which replays the WAL) always leaves a
consistent database on disk.
