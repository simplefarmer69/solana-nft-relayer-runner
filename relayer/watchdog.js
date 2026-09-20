// Solana NFT relayer WATCHDOG - read-only backlog check for the Solana <->
// Robinhood Chain NFT route. Holds NO keys.
//
// The relayer itself only ever reports what it can see: a tick that finds
// nothing to do is "ok", so a stall caused by a deposit the cursor skipped,
// a release the ledger walk never reached, or a dry escrow looks exactly
// like a quiet route (2026-09-20: 23 slabs sat at escrow for 8h behind a
// green runner). This process derives the backlog from CHAIN STATE ONLY,
// independent of the relayer's cursor or cache:
//
//   * DEPOSITS: every escrow deposit in the trailing WATCHDOG_WINDOW_SECS
//     (default 24h) that the gateway has NOT consumed. Deposits older than
//     WATCHDOG_GRACE_SECS (default 20 min) that are backed (asset still in
//     escrow), unwrapped, carry a valid recipient AND pass the deposit gate
//     are SERVABLE - a servable backlog means the mint worker is stalled.
//     Everything else is reported as parked (informational).
//   * RELEASES: every gateway release request still in Requested status
//     older than the grace window - the release worker is stalled.
//   * ESCROW SOL float below the warn line (releases will start failing).
//   * Gateway paused (every mint/release will revert).
//
// Exit code 1 on any stall so the scheduler surfaces it (GitHub Actions
// emails the repo owner on a failed run). Optional ALERT_WEBHOOK_URL gets a
// JSON POST ({text, content} - Slack/Discord/Telegram-bridge friendly) with
// the same summary. Never mints, never releases, never moves the cursor.
//
// Env: CONFIG_PATH (same json the relayer uses; releasesOnly skips the
// deposit lane), WATCHDOG_WINDOW_SECS, WATCHDOG_GRACE_SECS,
// WATCHDOG_ESCROW_SOL_WARN (default 0.03), ALERT_WEBHOOK_URL (optional).

const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { GATEWAY_ABI } = require("./index");

const STATUS_REQUESTED = 1;

function log(...args) {
  console.log(new Date().toISOString(), "[sol-nft-watchdog]", ...args);
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

async function postAlert(url, summary) {
  if (!url) return;
  const text = summary.lines.join("\n");
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, content: text.slice(0, 1900), summary }),
    });
    log(`alert webhook -> HTTP ${res.status}`);
  } catch (err) {
    log(`alert webhook failed: ${err.message}`);
  }
}

async function main() {
  const configPath = process.env.CONFIG_PATH || path.join(__dirname, "config.json");
  const cfg = loadJson(configPath);
  const windowSecs = Number(process.env.WATCHDOG_WINDOW_SECS || 86400);
  const graceSecs = Number(process.env.WATCHDOG_GRACE_SECS || 1200);
  const solWarn = Number(process.env.WATCHDOG_ESCROW_SOL_WARN || 0.03);
  const now = Math.floor(Date.now() / 1000);

  const provider = new ethers.JsonRpcProvider(cfg.evm.rpc, cfg.evm.chainId, {
    staticNetwork: true,
    cacheTimeout: -1,
  });
  const gateway = new ethers.Contract(cfg.evm.gateway, GATEWAY_ABI, provider);

  const { SolanaRpcAdapter } = require("./solana-adapter");
  const escrowHex = await gateway.solanaEscrow();
  const bs58 = require("bs58").default || require("bs58");
  const escrowB58 = bs58.encode(Buffer.from(escrowHex.slice(2), "hex"));
  const adapter = new SolanaRpcAdapter({ rpcUrl: cfg.solana.rpcUrl, escrowPubkey: escrowB58 });

  const stalls = [];
  const info = [];

  // Gateway liveness.
  const paused = await gateway.paused();
  if (paused) stalls.push(`gateway ${cfg.evm.gateway} is PAUSED - every mint and release reverts`);

  // Escrow SOL float (every release pays rent out of it).
  const lamports = Number(await adapter.escrowLamports());
  const sol = lamports / 1e9;
  info.push(`escrow ${escrowB58} holds ${sol.toFixed(4)} SOL`);
  if (sol < solWarn) {
    stalls.push(
      `ESCROW-SOL-LOW: escrow ${escrowB58} holds ${sol.toFixed(4)} SOL (< ${solWarn}) - releases will fail; ops-bot solbridge refills via Relay`
    );
  }

  // Release lane: the gateway ledger is the queue.
  const next = Number(await gateway.nextReleaseNonce());
  let pendingReleases = 0;
  const staleReleases = [];
  for (let nonce = 1; nonce < next; nonce++) {
    const req = await gateway.releaseRequests(nonce);
    if (Number(req.status) !== STATUS_REQUESTED) continue;
    pendingReleases++;
    const age = now - Number(req.requestedAt);
    if (age > graceSecs) {
      staleReleases.push(
        `nonce ${nonce} mint ${bs58.encode(Buffer.from(req.solanaMint.slice(2), "hex"))} requested ${Math.round(age / 60)} min ago`
      );
    }
  }
  info.push(`releases: ${next - 1} requested lifetime, ${pendingReleases} pending, ${staleReleases.length} past grace`);
  if (staleReleases.length) {
    stalls.push(
      `RELEASE WORKER STALLED: ${staleReleases.length} bridge-back(s) unserved for > ${graceSecs / 60} min\n  ` +
        staleReleases.join("\n  ")
    );
  }

  // Deposit lane (skipped for releases-only gateways).
  if (!cfg.releasesOnly) {
    const wrapped = new ethers.Contract(
      await gateway.wrapped(),
      ["function isWrapped(bytes32) view returns (bool)"],
      provider
    );
    let gateOpen = true;
    try {
      gateOpen = await gateway.depositsOpen();
    } catch {
      gateOpen = true; // pre-gate bytecode
    }
    const deposits = await adapter.fetchDepositsSince(windowSecs);
    let processed = 0;
    let fresh = 0;
    const servable = [];
    const parked = [];
    for (const dep of deposits) {
      const depositId = ethers.keccak256(ethers.concat([dep.sigHex, dep.mintHex]));
      if (await gateway.processedDeposits(depositId)) {
        processed++;
        continue;
      }
      const age = typeof dep.blockTime === "number" ? now - dep.blockTime : null;
      if (age !== null && age < graceSecs) {
        fresh++;
        continue;
      }
      const mintB58 = bs58.encode(Buffer.from(dep.mintHex.slice(2), "hex"));
      const label = `${mintB58} (deposit ${depositId.slice(0, 10)}, ${age === null ? "?" : Math.round(age / 60)} min old)`;
      let recipient = null;
      try {
        recipient = ethers.getAddress(String(dep.recipientEvm).toLowerCase());
      } catch {
        /* parked */
      }
      if (!recipient || recipient === ethers.ZeroAddress) {
        parked.push(`${label}: invalid recipient memo`);
        continue;
      }
      if (await wrapped.isWrapped(dep.mintHex)) {
        parked.push(`${label}: already wrapped`);
        continue;
      }
      if (!gateOpen) {
        let allowed = true;
        try {
          allowed = await gateway.depositRecipientAllowed(recipient);
        } catch {
          allowed = true;
        }
        if (!allowed) {
          parked.push(`${label}: recipient ${recipient} not allowlisted (deposit gate closed)`);
          continue;
        }
      }
      if (!(await adapter.isInEscrow(dep.mintHex))) {
        parked.push(`${label}: asset no longer in escrow (released)`);
        continue;
      }
      servable.push(`${label} -> ${recipient}`);
    }
    info.push(
      `deposits (last ${Math.round(windowSecs / 3600)}h): ${deposits.length} seen, ${processed} minted, ` +
        `${fresh} inside grace, ${servable.length} SERVABLE past grace, ${parked.length} parked`
    );
    for (const p of parked) info.push(`  parked: ${p}`);
    if (servable.length) {
      stalls.push(
        `MINT WORKER STALLED: ${servable.length} servable deposit(s) unminted for > ${graceSecs / 60} min\n  ` +
          servable.join("\n  ")
      );
    }
  }

  const lines = [
    `${stalls.length ? "STALL" : "OK"} | gateway ${cfg.evm.gateway} | ${new Date().toISOString()}`,
    ...info,
    ...stalls.map((s) => `ALERT: ${s}`),
  ];
  for (const l of lines) log(l);
  if (stalls.length) {
    await postAlert(process.env.ALERT_WEBHOOK_URL, { gateway: cfg.evm.gateway, stalls, lines });
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}

module.exports = { main };
