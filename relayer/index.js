// Solana NFT relayer — the operator process behind the Solana ↔ Robinhood
// Chain NFT route (SolanaNftGateway.sol).
//
// The route is deliberately custodial and EOA-based: NFTs escrow in a plain
// Solana EOA (no program on the Solana side), and this process is the only
// mover between the two chains. Per tick it:
//
//   A) DEPOSITS (Solana -> Robinhood): asks the Solana adapter for FINALIZED
//      NFT transfers into the escrow EOA that carry an SPL Memo with the EVM
//      recipient. For each, depositId = keccak256(raw 64-byte tx signature);
//      if the gateway hasn't consumed it, submit mintFromDeposit. The gateway
//      is the replay wall — a crashed/restarted/duplicated relayer can never
//      double-mint, it just wastes gas on a revert.
//
//   B) RELEASES (Robinhood -> Solana): iterates the gateway's OWN release
//      ledger — nextReleaseNonce() + releaseRequests(nonce) — from a floor
//      nonce, never event logs. The contract state is the source of truth,
//      so a relayer that lost ALL local state simply re-iterates from nonce
//      1 with cheap view calls and finds every request still in Requested
//      status. For each: transfer the NFT out of the Solana escrow to the
//      recipient, then markReleased on the gateway. Delivery precedes
//      bookkeeping, and the adapter is idempotent (an already-delivered
//      mint reports alreadyReleased instead of double-sending), so a crash
//      between the two steps self-heals.
//
// STATELESS-SAFE BY DESIGN (2026-08-16): local state (solanaCursor,
// nonceFloor) is a pure OPTIMIZATION. Losing it is always safe:
//   * releases re-derive from the on-chain ledger (above);
//   * deposits re-scan from cfg.solana.genesisCursor (a pinned signature
//     from BEFORE the route opened) and every re-seen deposit is skipped by
//     the gateway's processedDeposits replay wall or parked by the
//     already-wrapped check. The genesis cursor also permanently fences off
//     any signature that predates the (sig ‖ asset) depositId derivation.
// This is what lets the relayer run as a scheduled serverless job (GitHub
// Actions cron) with best-effort state caching instead of a hosted daemon.
//
// SAFETY ORDER OF OPERATIONS: the Solana cursor only advances after every
// deposit in the batch was either minted or confirmed already-processed; a
// failed mint aborts the tick and the batch retries. Same for the release
// nonce floor. The cursor also never lands on a signature younger than the
// adapter's settle lag (default 10 min, SOLANA_CURSOR_LAG_SECS): RPC address
// indexes converge asynchronously, and a cursor pinned to the newest visible
// signature can fence off deposits that surface a few seconds later
// (2026-09-20: 23 of a 24-slab batch skipped that way). Fresh deposits are
// re-scanned every tick until they settle; the replay wall makes that free.
//
// watchdog.js is the cursor-independent backlog check that turns a silent
// stall of either lane into a failed scheduled run.
//
// Config: CONFIG_PATH (json) + OPERATOR_KEY env (the gateway operator EOA).
// Solana custody key: SOLANA_ESCROW_KEY env (JSON byte array) in rpc mode.
// RELAYER_RUN_MS env (optional): tick for that many ms then exit 0 — the
// one-shot mode a scheduled runner uses. Unset = loop forever (daemon mode).
// See config.example.json. The module also exports createRelayer() so the
// end-to-end harness (scripts/solana-nft-e2e.js) can drive THIS exact code
// in-process against a mock Solana ledger.

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const GATEWAY_ABI = [
  "function processedDeposits(bytes32) view returns (bool)",
  "function depositsOpen() view returns (bool)",
  "function depositRecipientAllowed(address) view returns (bool)",
  "function nextReleaseNonce() view returns (uint256)",
  "function releaseRequests(uint256) view returns (bytes32 solanaMint, bytes32 solanaRecipient, address requestedBy, uint40 requestedAt, uint8 status, bytes32 solanaTxSigHash)",
  "function mintFromDeposit(bytes32 depositId, bytes32 solanaMint, address recipient, string uri) returns (uint256)",
  "function markReleased(uint256 nonce, bytes32 solanaTxSigHash)",
  "function paused() view returns (bool)",
  "function operator() view returns (address)",
  "function solanaEscrow() view returns (bytes32)",
  "function wrapped() view returns (address)",
];

const WRAPPED_ABI = ["function isWrapped(bytes32) view returns (bool)"];

const STATUS_REQUESTED = 1;
// Escrow SOL float: a pNFT release needs ~0.0011 SOL (recipient token-account
// rent + fee) on top of the escrow's own rent-exempt minimum (~0.0009 SOL).
const ESCROW_SOL_HARD_FLOOR_LAMPORTS = Number(process.env.ESCROW_SOL_HARD_FLOOR_LAMPORTS || 3_000_000); // 0.003 SOL
const ESCROW_SOL_WARN_LAMPORTS = Number(process.env.ESCROW_SOL_WARN_LAMPORTS || 30_000_000); // 0.03 SOL

function log(...args) {
  console.log(new Date().toISOString(), "[sol-nft-relayer]", ...args);
}

function loadJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

// tokenURI is attacker-controlled twice over (deposit memo AND the asset's
// own on-chain metadata), and it lands verbatim in wallets/marketplaces via
// tokenURI(). Sanitize at the ONE chokepoint every mint passes through:
// only well-formed http(s)/ipfs/ar URIs of sane length survive; anything
// else (javascript:, data:, control chars, megabyte bombs) mints with an
// EMPTY uri instead — the asset still bridges, the payload does not.
const URI_MAX_LEN = 512;
const URI_ALLOWED = /^(https?|ipfs|ar):\/\/[\x21-\x7e]+$/;
function sanitizeUri(uri) {
  const s = String(uri ?? "").trim();
  if (s === "") return "";
  if (s.length > URI_MAX_LEN) return "";
  return URI_ALLOWED.test(s) ? s : "";
}

// The asset's on-chain metadata NAME, scrubbed for the fallback path below:
// printable ASCII + common unicode letters only, control chars stripped
// (Token Metadata pads names with \x00), hard length cap. Untrusted input —
// it only ever lands inside a JSON string we construct ourselves.
const NAME_MAX_LEN = 96;
function sanitizeName(name) {
  const s = String(name ?? "")
    .replace(/[\x00-\x1f\x7f]/g, "")
    .trim();
  return s.slice(0, NAME_MAX_LEN);
}

// Name-preservation fallback: when a deposit has NO usable remote URI (bare
// asset with no metadata account, or a hostile URI the sanitizer scrubbed),
// mint with a self-contained data: metadata JSON so the asset's NAME still
// renders in wallets/marketplaces. Deliberately constructed AFTER the
// sanitize gate from sanitized inputs only — this is the one data: URI the
// relayer ever emits, and it never contains attacker-shaped bytes
// (JSON.stringify escapes the name, base64 flattens the rest).
function nameOnlyDataUri(name, mintHex) {
  const meta = {
    name,
    description: `Bridged from Solana. Original mint: ${mintHex}`,
  };
  return (
    "data:application/json;base64," +
    Buffer.from(JSON.stringify(meta), "utf8").toString("base64")
  );
}

/// Build the relayer. `adapter` implements:
///   fetchDeposits(cursor) -> { deposits: [{sigHex, mintHex, recipientEvm, uri, name?}], cursor }
///     (FINALIZED deposits only, oldest first, deterministic cursor)
///   releaseNft(mintHex, recipientHex) -> { sigHex, alreadyReleased }
///     (idempotent: if the recipient already holds the mint, report
///      alreadyReleased instead of failing or double-sending)
function createRelayer(cfg, { adapter, key, statePath } = {}) {
  if (!adapter) throw new Error("adapter required");
  if (!key) throw new Error("operator key required");
  const provider = new ethers.JsonRpcProvider(cfg.evm.rpc, cfg.evm.chainId, {
    staticNetwork: true,
    cacheTimeout: -1,
  });
  const signer = new ethers.Wallet(key, provider);
  const gateway = new ethers.Contract(cfg.evm.gateway, GATEWAY_ABI, signer);
  const reader = new ethers.Contract(cfg.evm.gateway, GATEWAY_ABI, provider);

  // Local state is an OPTIMIZATION only (see header) — the bootstrap values
  // are always safe: genesisCursor fences pre-route Solana history, and
  // nonceFloor 1 re-walks the whole on-chain release ledger with view calls.
  const state = (statePath && loadJson(statePath, null)) || {
    solanaCursor: (cfg.solana && cfg.solana.genesisCursor) || null,
    nonceFloor: 1,
  };
  if (!state.nonceFloor) state.nonceFloor = 1; // migrate pre-2026-08-16 state files

  function persist() {
    if (statePath) fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  }

  let wrappedReader = null;
  async function getWrappedReader() {
    if (!wrappedReader) {
      wrappedReader = new ethers.Contract(await reader.wrapped(), WRAPPED_ABI, provider);
    }
    return wrappedReader;
  }

  // Deposit gate probe. Gated bytecode (2026-08-16+) exposes depositsOpen()
  // + depositRecipientAllowed(); pre-gate bytecode reverts the probe and is
  // treated as open (it has no gate to enforce). Cached per recipient per
  // tick-batch is unnecessary — these are cheap view calls.
  let gateSupported = null;
  async function recipientAllowed(recipient) {
    if (gateSupported === false) return true;
    try {
      const open = await reader.depositsOpen();
      gateSupported = true;
      if (open) return true;
      return await reader.depositRecipientAllowed(recipient);
    } catch (err) {
      // Missing-function reverts decode as BAD_DATA/CALL_EXCEPTION in ethers
      // v6 — that means pre-gate bytecode. Anything else (network, timeout)
      // is transient and must THROW so the tick aborts and retries; a
      // misclassification can never mint wrongly (the chain enforces the
      // gate), it could only wedge one tick.
      if (gateSupported === null && (err.code === "BAD_DATA" || err.code === "CALL_EXCEPTION")) {
        gateSupported = false;
        log("gateway bytecode has no deposit gate — treating deposits as open (legacy)");
        return true;
      }
      throw err;
    }
  }

  // Deposits inside the adapter's cursor settle lag are re-scanned every
  // tick until the signature index has converged (see solana-adapter.js
  // header). Their skip/park outcomes are deterministic, so announce each
  // once per process instead of once per tick.
  const announced = new Set();
  function announceOnce(depositId, line) {
    if (announced.has(depositId)) return;
    announced.add(depositId);
    log(line);
  }

  async function processDeposits() {
    const { deposits, cursor } = await adapter.fetchDeposits(state.solanaCursor);
    for (const dep of deposits) {
      // Per-ASSET deposit id: one Solana tx may deposit MANY NFTs under one
      // memo (batch bridging), so the replay wall keys on (tx sig, asset) —
      // keccak(sig) alone would let only the first asset of a batch mint.
      const depositId = ethers.keccak256(ethers.concat([dep.sigHex, dep.mintHex]));
      if (announced.has(depositId)) continue; // settled this process: minted/parked/skipped
      if (await reader.processedDeposits(depositId)) {
        announceOnce(depositId, `deposit ${depositId.slice(0, 10)} already processed, skipping`);
        continue;
      }

      // PERMANENT failures PARK (skip + log): these deposits can never mint,
      // so throwing would wedge the cursor forever behind one poisoned
      // deposit — the classic griefing vector against a fail-closed cursor.
      // The NFT stays safe in escrow for the manual ops-return path.
      //
      //   * unparseable / zero EVM recipient in the memo (the gateway would
      //     revert ZeroAddress; ethers itself throws on a bad-checksum
      //     mixed-case address before a tx is even built);
      //   * the mint is already wrapped (a second live wrap is impossible
      //     by construction — ERC721InvalidSender forever).
      //
      // Everything else (gateway paused, mint throttled, rpc errors) is
      // TRANSIENT and still THROWS: the cursor must not advance over a
      // deposit that will mint on retry.
      let recipient = null;
      try {
        recipient = ethers.getAddress(String(dep.recipientEvm).toLowerCase());
      } catch {
        /* parked below */
      }
      if (!recipient || recipient === ethers.ZeroAddress) {
        announceOnce(depositId, `PARKED deposit ${depositId.slice(0, 10)}: invalid recipient "${dep.recipientEvm}"`);
        continue;
      }
      if (await (await getWrappedReader()).isWrapped(dep.mintHex)) {
        announceOnce(
          depositId,
          `PARKED deposit ${depositId.slice(0, 10)}: mint ${dep.mintHex.slice(0, 10)} ` +
            `already wrapped — manual ops return required`
        );
        continue;
      }
      // DEPOSIT GATE: while the gateway's gate is closed, only allowlisted
      // recipients mint. A gated-out deposit is a PERMANENT failure for the
      // relayer (the chain would revert RecipientNotAllowed forever), so it
      // parks — NFT safe in escrow for the guarded manual-return tool.
      if (!(await recipientAllowed(recipient))) {
        announceOnce(
          depositId,
          `PARKED deposit ${depositId.slice(0, 10)}: recipient ${recipient} ` +
            `not allowlisted while the deposit gate is closed`
        );
        continue;
      }
      // CUSTODY CHECK at mint time, not scan time: a wrap must never exist
      // without its asset in escrow. Guards stateless full-history rescans
      // against stale deposit records for assets released since (the asset
      // is provably elsewhere, so this can never park a servable deposit).
      if (adapter.isInEscrow && !(await adapter.isInEscrow(dep.mintHex))) {
        // A custody miss on a FRESH deposit is provider lag, not a stale
        // record: the 2026-09-20 tick that ran 5s after a batch read two
        // just-created escrow token accounts as empty and parked both. Inside
        // the settle window the deposit is re-scanned next tick anyway, so
        // leave it unannounced and let the read converge; only a deposit old
        // enough to be outside the window is a genuine stale record.
        const ageSecs =
          typeof dep.blockTime === "number" ? Math.floor(Date.now() / 1000) - dep.blockTime : null;
        const lag = Number(adapter.cursorLagSecs || 0);
        if (ageSecs !== null && lag > 0 && ageSecs < lag) {
          if (!announced.has(`fresh:${depositId}`)) {
            announced.add(`fresh:${depositId}`);
            log(
              `custody of ${dep.mintHex.slice(0, 10)} not visible yet for fresh deposit ` +
                `${depositId.slice(0, 10)} (${ageSecs}s old) — retrying next tick`
            );
          }
          continue;
        }
        announceOnce(
          depositId,
          `PARKED deposit ${depositId.slice(0, 10)}: asset ${dep.mintHex.slice(0, 10)} ` +
            `not in escrow — stale record, never minting unbacked`
        );
        continue;
      }

      let uri = sanitizeUri(dep.uri);
      if ((dep.uri ?? "") !== "" && uri === "") {
        log(`SCRUBBED uri on deposit ${depositId.slice(0, 10)} (disallowed scheme/shape)`);
      }
      if (uri === "") {
        const name = sanitizeName(dep.name);
        if (name !== "") {
          uri = nameOnlyDataUri(name, dep.mintHex);
          log(
            `FALLBACK metadata on deposit ${depositId.slice(0, 10)}: ` +
              `name-only data URI ("${name}")`
          );
        }
      }
      const tx = await gateway.mintFromDeposit(depositId, dep.mintHex, recipient, uri);
      await tx.wait();
      announced.add(depositId);
      log(`MINTED wrap for mint ${dep.mintHex.slice(0, 10)} -> ${recipient} (${tx.hash})`);
    }
    state.solanaCursor = cursor;
  }

  async function processReleases() {
    // The gateway's release ledger IS the queue: walk nonces from the floor
    // to nextReleaseNonce and serve everything still in Requested status.
    // No event logs, no block cursor — pure contract state, so this fully
    // recovers from zero local state. The floor only advances past a nonce
    // once it is TERMINAL (released/reissued); a failed delivery throws and
    // the whole range retries next tick.
    const next = await reader.nextReleaseNonce();
    let floor = BigInt(state.nonceFloor || 1);
    let solChecked = false;
    for (let nonce = floor; nonce < next; nonce++) {
      const req = await reader.releaseRequests(nonce);
      if (Number(req.status) !== STATUS_REQUESTED) {
        floor = nonce + 1n; // terminal — skip forever
        continue;
      }
      // SOL float preflight, once per tick and only when something needs
      // serving: a release pays ~0.0011 SOL of token-account rent out of the
      // escrow, and a dry escrow otherwise fails as an opaque simulation
      // error. Below the hard floor we fail loud with the fix in the message;
      // below the warn line we log early so the float gets topped up first.
      if (!solChecked && adapter.escrowLamports) {
        solChecked = true;
        const lamports = Number(await adapter.escrowLamports());
        const sol = (lamports / 1e9).toFixed(4);
        const escrow = adapter.escrowAddress ? adapter.escrowAddress() : "escrow";
        if (lamports < ESCROW_SOL_HARD_FLOOR_LAMPORTS) {
          throw new Error(
            `ESCROW-SOL-EMPTY: escrow ${escrow} holds ${sol} SOL, under the ` +
              `${ESCROW_SOL_HARD_FLOOR_LAMPORTS / 1e9} SOL release floor - ` +
              `top it up (ops-bot solbridge job refills via Relay) before releases can be served`
          );
        }
        if (lamports < ESCROW_SOL_WARN_LAMPORTS) {
          log(`ESCROW-SOL-LOW: escrow ${escrow} holds ${sol} SOL - top up before it runs dry`);
        }
      }
      // Deliver on Solana FIRST, then close the books on-chain. The adapter
      // is idempotent, so a crash between the two steps cannot double-send.
      const { sigHex, alreadyReleased } = await adapter.releaseNft(
        req.solanaMint,
        req.solanaRecipient
      );
      const sigHash = sigHex ? ethers.keccak256(sigHex) : ethers.ZeroHash;
      const tx = await gateway.markReleased(nonce, sigHash);
      await tx.wait();
      log(
        `RELEASED nonce ${nonce} mint ${req.solanaMint.slice(0, 10)}` +
          (alreadyReleased ? " (was already delivered)" : "") +
          ` (${tx.hash})`
      );
      floor = nonce + 1n;
      // A delivery that fails THROWS, aborting the tick before persist() —
      // the floor can never advance past an unserved request.
    }
    state.nonceFloor = floor.toString();
  }

  async function tick() {
    // releasesOnly: serve bridge-backs but never mint — the mode a RETIRED
    // gateway runs in so its existing wraps can always exit while no new
    // wrap can ever enter through it.
    if (!cfg.releasesOnly) await processDeposits();
    await processReleases();
    persist();
  }

  let running = false;
  async function start(pollMs = Number(cfg.pollMs || 5000)) {
    running = true;
    log(`operator ${signer.address} watching gateway ${cfg.evm.gateway}`);
    while (running) {
      try {
        await tick();
      } catch (err) {
        log(`TICK-FAIL: ${err.message}`); // fail closed; state not advanced past the failure
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  return { tick, start, stop: () => (running = false), state, signer };
}

async function main() {
  const configPath = process.env.CONFIG_PATH || path.join(__dirname, "config.json");
  const cfg = loadJson(configPath, null);
  if (!cfg || !cfg.evm) throw new Error(`config with evm{} required at ${configPath}`);
  const key = process.env.OPERATOR_KEY;
  if (!key) throw new Error("OPERATOR_KEY required");

  let adapter;
  if ((cfg.solana && cfg.solana.mode) === "mock") {
    const { MockSolana } = require("./mock-solana");
    adapter = new MockSolana({ escrowHex: cfg.solana.escrowHex });
    log("using MOCK solana ledger (local rehearsal only)");
  } else {
    // Lazy require: the Solana SDK deps are only needed in rpc mode.
    const { SolanaRpcAdapter } = require("./solana-adapter");
    const escrowKey = process.env.SOLANA_ESCROW_KEY;
    if (!escrowKey) throw new Error("SOLANA_ESCROW_KEY required in rpc mode");
    adapter = new SolanaRpcAdapter({
      rpcUrl: cfg.solana.rpcUrl,
      escrowSecretKey: JSON.parse(escrowKey),
    });
  }

  const statePath = process.env.STATE_PATH || path.join(__dirname, "relayer-state.json");
  const relayer = createRelayer(cfg, { adapter, key, statePath });

  // One-shot mode for scheduled runners (GitHub Actions cron): tick for
  // RELAYER_RUN_MS then exit cleanly so the next scheduled run takes over.
  const runMs = Number(process.env.RELAYER_RUN_MS || 0);
  if (runMs > 0) {
    const deadline = Date.now() + runMs;
    const pollMs = Number(cfg.pollMs || 5000);
    let ok = 0;
    let failed = 0;
    log(`one-shot mode: ticking for ${runMs}ms`);
    while (Date.now() < deadline) {
      try {
        await relayer.tick();
        ok++;
      } catch (err) {
        failed++;
        log(`TICK-FAIL: ${err.message}`); // fail closed; state not advanced past the failure
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    log(`one-shot window over (${ok} ok, ${failed} failed), exiting`);
    // Every tick failing means the runner is blind (rpc egress, bad key,
    // paused gateway) — exit nonzero so the scheduler surfaces the failure
    // (GitHub Actions emails the repo owner) instead of green-washing it.
    if (ok === 0 && failed > 0) process.exit(1);
    return;
  }

  await relayer.start();
}

module.exports = { createRelayer, GATEWAY_ABI, sanitizeUri, sanitizeName, nameOnlyDataUri };

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
