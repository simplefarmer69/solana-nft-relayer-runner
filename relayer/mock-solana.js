// In-memory Solana ledger implementing the exact adapter interface the
// relayer consumes. Used by scripts/solana-nft-e2e.js to drive the REAL
// relayer + REAL gateway contract without a Solana validator. Local
// rehearsal only — never wire this into a production config.

const crypto = require("crypto");

function randHex(bytes) {
  return "0x" + crypto.randomBytes(bytes).toString("hex");
}

function norm(hex) {
  return String(hex).toLowerCase();
}

class MockSolana {
  constructor({ escrowHex }) {
    if (!escrowHex) throw new Error("escrowHex required");
    this.escrow = norm(escrowHex);
    this.owners = new Map(); // mintHex -> ownerHex (32-byte solana pubkeys)
    this.depositLog = []; // append-only: { sigHex, mintHex, recipientEvm, uri }
    this.releaseLog = []; // { sigHex, mintHex, recipientHex }
    this.failRecipients = new Set(); // simulate undeliverable recipients
  }

  // ---- test-harness helpers (not part of the adapter interface) ----

  createNft(ownerHex) {
    const mintHex = randHex(32);
    this.owners.set(mintHex, norm(ownerHex));
    return mintHex;
  }

  ownerOf(mintHex) {
    return this.owners.get(norm(mintHex)) ?? null;
  }

  /// The user-side action: transfer the NFT to the escrow EOA with a memo
  /// carrying the EVM recipient (and optional URI). Returns the deposit tx
  /// signature (64 bytes, like a real Solana signature).
  depositToEscrow(mintHex, fromHex, recipientEvm, uri = "") {
    const m = norm(mintHex);
    if (this.owners.get(m) !== norm(fromHex)) throw new Error("mock: depositor does not own mint");
    this.owners.set(m, this.escrow);
    const sigHex = randHex(64);
    this.depositLog.push({ sigHex, mintHex: m, recipientEvm, uri });
    return sigHex;
  }

  /// Batch deposit: MANY NFTs move to the escrow in ONE Solana transaction
  /// (one signature) under one shared memo — exactly what a multi-select
  /// bridge UI produces. Returns the single shared tx signature.
  depositManyToEscrow(mintHexes, fromHex, recipientEvm, uri = "") {
    const sigHex = randHex(64);
    for (const mintHex of mintHexes) {
      const m = norm(mintHex);
      if (this.owners.get(m) !== norm(fromHex)) throw new Error("mock: depositor does not own mint");
      this.owners.set(m, this.escrow);
      this.depositLog.push({ sigHex, mintHex: m, recipientEvm, uri });
    }
    return sigHex;
  }

  setUndeliverable(recipientHex, undeliverable = true) {
    if (undeliverable) this.failRecipients.add(norm(recipientHex));
    else this.failRecipients.delete(norm(recipientHex));
  }

  // ---- adapter interface (what the relayer calls) ----

  async fetchDeposits(cursor) {
    const start = Number(cursor ?? 0);
    return {
      deposits: this.depositLog.slice(start),
      cursor: this.depositLog.length,
    };
  }

  async isInEscrow(mintHex) {
    return this.owners.get(norm(mintHex)) === this.escrow;
  }

  async releaseNft(mintHex, recipientHex) {
    const m = norm(mintHex);
    const r = norm(recipientHex);
    if (this.failRecipients.has(r)) throw new Error("mock: undeliverable recipient");
    const owner = this.owners.get(m);
    if (owner !== this.escrow) {
      // Idempotence: a crash after delivery but before markReleased must not
      // double-send. If the recipient already holds it, report that.
      if (owner === r) return { sigHex: null, alreadyReleased: true };
      throw new Error("mock: escrow does not hold mint");
    }
    this.owners.set(m, r);
    const sigHex = randHex(64);
    this.releaseLog.push({ sigHex, mintHex: m, recipientHex: r });
    return { sigHex, alreadyReleased: false };
  }
}

module.exports = { MockSolana };
