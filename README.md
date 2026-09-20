# Solana NFT relayer runner

Serverless operator for the **Solana ↔ Robinhood Chain NFT route**.

Primary gateway (2026-08-16, deposit-gated):
`0x261518C7a2364dc73e0724e8CA28c7370a6bcafe`, wrapped collection
**"TheCardWall Slabs" / `SLAB`**
`0x8565507566C6a79B57E4eaA70b8232a64003d352`, Solana escrow
`6PhrdEpWZ1V5kuhV5UrADjcwUuRapnDcXuDrPcaFPbKH`. The gateway's deposit gate
is CLOSED: fresh wraps mint only to owner-allowlisted recipients (relayer
parks anything else); **bridge-back is open to every holder, always**.

Retired first-generation gateway (releases only):
`0x1aD80bEdEBf23476bb5897b8a55AF7CDaAC5E014` ("Card Wall : Solana Vault" /
`wCARD`). The workflow serves its bridge-backs with `releasesOnly` so the
one existing wrap can always exit; it never mints there again.

There is **no hosted server**. A GitHub Actions workflow
(`.github/workflows/relayer.yml`) runs the relayer in a self-perpetuating
chain: each ~4-minute window dispatches the next one, giving continuous
coverage for free, with a cron as the backstop that restarts the chain if a
dispatch is ever lost. Typical end-to-end bridge wait is **1–5 minutes**;
worst case (chain broken + GitHub cron scheduler lag) ~15 minutes.

## Why this is safe to run statelessly

The relayer keeps **no state that matters**:

- Deposits (Solana → Robinhood): the gateway's `processedDeposits` replay
  wall is keyed per `(Solana tx signature, asset)`. Re-scanning history is a
  no-op; a pinned `genesisCursor` in `config.json` fences off everything
  before the route opened. Before every mint the relayer re-verifies the
  asset is **currently in escrow** on Solana, so a stale deposit record can
  never mint an unbacked wrap.
- Releases (Robinhood → Solana): the gateway's own ledger
  (`nextReleaseNonce` + `releaseRequests`) is walked directly — no event
  logs, no block cursors. Delivery on Solana is idempotent, and
  `markReleased` closes each request exactly once.

The `relayer-state.json` cache between runs is a pure optimization. Losing
it costs extra RPC reads, never correctness. The E2E harness in the source
repo proves this with a "total amnesia" phase (fresh relayer, zero state,
full re-scan, zero side effects).

## Secrets (repo settings → Actions secrets)

| Secret | Required | What |
| --- | --- | --- |
| `OPERATOR_KEY` | yes | EVM key of the gateway operator (mints wraps, marks releases). Rotatable instantly via `setOperator` on the gateway. |
| `SOLANA_ESCROW_KEY` | yes | Escrow EOA secret key as a JSON byte array. **This key IS custody of every escrowed NFT.** |
| `RH_RPC_URL` | no | Keyed Robinhood Chain RPC (public endpoint is the fallback). |
| `SOLANA_RPC_URL` | no | Keyed Solana RPC (public mainnet-beta is the fallback). |

If every tick in a run window fails, the job exits nonzero and GitHub
notifies the repo owner — a silently blind relayer never shows green.

| `ALERT_WEBHOOK_URL` | no | Optional. The watchdog POSTs a JSON `{text, content}` summary here on every detected stall (Slack / Discord / any webhook bridge). Without it, the failed run's GitHub email is the alert. |

## Watchdog (heartbeat for stalls the relayer cannot see)

A relayer tick that finds nothing to do is "ok", so a stall caused by a
deposit the cursor skipped, a release the ledger walk never reached, or a
dry escrow looks exactly like a quiet route (2026-09-20: 25 servable Card
Wall deposits sat at escrow for 8 hours behind green runs).
`.github/workflows/watchdog.yml` runs `relayer/watchdog.js` every 15
minutes — read-only, keyless, and **independent of the relayer's cursor
and cache** — and FAILS the run when:

- a servable deposit (asset in escrow, unwrapped, valid and allowlisted
  recipient) has been unminted for more than 20 minutes (mint worker stalled);
- a bridge-back has sat in `Requested` for more than 20 minutes (release
  worker stalled);
- the escrow SOL float is under 0.03 SOL (releases are about to fail);
- the gateway is paused;
- the relayer chain itself is dead (no `relayer.yml` run in 20 minutes, or
  the last three all failed).

Deposits that are parked for a permanent reason (bad memo, non-allowlisted
recipient, already wrapped, asset already released) are listed as
informational and do not fail the run. Knobs: `WATCHDOG_WINDOW_SECS`
(trailing window scanned, default 24h), `WATCHDOG_GRACE_SECS` (default
1200), `WATCHDOG_ESCROW_SOL_WARN` (default 0.03).

## Cursor settle lag (why the relayer re-scans the last 10 minutes)

`getSignaturesForAddress` is served from an address index that RPC nodes
populate asynchronously from finality, and load-balanced providers answer
from different nodes. Pinning the cursor to the newest visible signature
can therefore fence off deposits that surface in the index a few seconds
later (the 2026-09-20 stall: a tick 5s after a 10-tx batch saw three txs,
minted one, and never scanned the other seven again). The relayer now
never advances the cursor onto a signature younger than
`SOLANA_CURSOR_LAG_SECS` (default 600); fresh signatures are re-scanned
every tick until they settle, which the gateway replay wall makes
side-effect free. A custody read that misses on a deposit inside that
window is treated as provider lag and retried, not parked.

## Self-hosting instead

Anyone the gateway owner appoints can run this exact code anywhere
(daemon mode: `node relayer/index.js` with `CONFIG_PATH`, `OPERATOR_KEY`,
`SOLANA_ESCROW_KEY`, no `RELAYER_RUN_MS`). Taking over operations means
taking custody: the gateway owner calls `setOperator(yourEvmAddress)` and
rotates the Solana escrow (`setSolanaEscrow` + moving the escrowed assets),
after which your keys run the route and these Actions secrets are revoked.
Running a SECOND relayer in parallel is harmless — the gateway's replay
wall and release statuses make duplicates waste gas at worst.

## Source of truth

The relayer code here is vendored from the bridge repo
(`services/solana-nft-relayer` in `simplefarmer69/stonk-stock-bridge`,
mirrored to `simplefarmer69/tickeryard-stock-bridge`). Sync this copy when
that service changes.
