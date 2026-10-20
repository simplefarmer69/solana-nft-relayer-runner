"use strict";
// Endpoint failover for the relayer + watchdog. Config values may be a single
// URL, a comma separated list, or an array; the first endpoint that answers
// (and, for EVM, serves a fresh head) wins. A rotated or revoked keyed RPC
// therefore degrades to the public endpoint instead of failing every tick.

const UA = "Mozilla/5.0 (solana-nft-relayer)";
const TIMEOUT_MS = 8000;
const MAX_HEAD_AGE_SECS = Number(process.env.RPC_MAX_HEAD_AGE_SECS || 300);

function toList(v) {
  if (!v) return [];
  const raw = Array.isArray(v) ? v : String(v).split(",");
  const out = [];
  for (const u of raw.map((s) => String(s).trim()).filter(Boolean)) {
    if (!out.includes(u)) out.push(u);
  }
  return out;
}

function label(url) {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}

async function rpc(url, method, params = []) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": UA },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(`rpc ${j.error.code}: ${j.error.message}`);
    return j.result;
  } finally {
    clearTimeout(t);
  }
}

async function pickEvmRpc(value, log = console.log) {
  const list = toList(value);
  if (!list.length) throw new Error("no EVM rpc configured");
  const errors = [];
  for (const url of list) {
    try {
      const blk = await rpc(url, "eth_getBlockByNumber", ["latest", false]);
      const age = Math.floor(Date.now() / 1000) - Number(BigInt(blk.timestamp));
      if (age > MAX_HEAD_AGE_SECS) throw new Error(`stale head (${age}s old)`);
      if (errors.length) log(`RPC-FAILOVER evm -> ${label(url)} (skipped: ${errors.join("; ")})`);
      return url;
    } catch (e) {
      errors.push(`${label(url)} ${e.message}`);
    }
  }
  throw new Error(`RPC-DEAD evm: every endpoint failed (${errors.join("; ")})`);
}

async function pickSolanaRpc(value, log = console.log) {
  const list = toList(value);
  if (!list.length) throw new Error("no Solana rpc configured");
  const errors = [];
  for (const url of list) {
    try {
      await rpc(url, "getSlot", [{ commitment: "finalized" }]);
      if (errors.length) log(`RPC-FAILOVER solana -> ${label(url)} (skipped: ${errors.join("; ")})`);
      return url;
    } catch (e) {
      errors.push(`${label(url)} ${e.message}`);
    }
  }
  throw new Error(`RPC-DEAD solana: every endpoint failed (${errors.join("; ")})`);
}

module.exports = { toList, pickEvmRpc, pickSolanaRpc };
