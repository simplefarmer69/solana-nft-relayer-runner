// Real Solana adapter for the NFT relayer — plain EOA custody, no program.
//
// Supports BOTH Solana NFT shapes that hold real assets today:
//
//   * classic SPL NFTs (mint + token accounts, amount 1 / decimals 0):
//     deposits are detected from the escrow's post-token-balance diff,
//     releases go out via transferChecked from the escrow ATA;
//
//   * Metaplex Core assets (program CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d,
//     ONE account per asset, no mint/ATA at all — e.g. Collector Crypt vaulted
//     cards): deposits are detected from a Core TransferV1 instruction whose
//     asset account now belongs to the escrow, releases go out via mpl-core
//     transferV1 (escrow signs as owner AND pays fees).
//
// Deposits: users transfer their NFT to the escrow EOA in a transaction that
// ALSO carries an SPL Memo instruction of the form:
//
//   0x<40-hex evm recipient>            or
//   0x<40-hex evm recipient>|<tokenURI>
//
// SPL deposits into an ALREADY-EXISTING escrow ATA must also include a
// 1-lamport System transfer to the escrow EOA (the "doorbell") — without it
// the transaction never mentions the escrow's own address and
// getSignaturesForAddress cannot see it. ATA-creating deposits and Core
// deposits mention the escrow inherently. UIs should always add the doorbell.
//
// The adapter only surfaces FINALIZED transactions and skips anything without
// a valid memo — an NFT parked without a memo stays in escrow for manual ops
// return, it is never guessed into a mint.
//
// Releases are idempotent (recipient-already-holds reports alreadyReleased)
// so a relayer crash between the Solana send and the on-chain markReleased
// can never double-deliver.
//
// Requires (rpc mode only): @solana/web3.js, @solana/spl-token, bs58, and for
// Core assets @metaplex-foundation/{umi,umi-bundle-defaults,mpl-core}.

const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const CORE_PROGRAM_ID = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
const CORE_TRANSFER_DISCRIMINATOR = 14; // mpl-core TransferV1

function lazyDeps() {
  // Kept out of module scope so mock-mode users never need these installed.
  const web3 = require("@solana/web3.js");
  const spl = require("@solana/spl-token");
  const bs58 = require("bs58").default || require("bs58");
  return { web3, spl, bs58 };
}

function lazyUmi() {
  // Only needed when a Metaplex Core asset actually moves.
  const { createUmi } = require("@metaplex-foundation/umi-bundle-defaults");
  const { mplCore, transferV1 } = require("@metaplex-foundation/mpl-core");
  const { keypairIdentity, publicKey } = require("@metaplex-foundation/umi");
  return { createUmi, mplCore, transferV1, keypairIdentity, publicKey };
}

function hexToBytes(hex) {
  return Buffer.from(hex.replace(/^0x/, ""), "hex");
}

/// Borsh string at `offset`: u32 LE length + utf8 bytes. Returns
/// [string|null, nextOffset]. Token Metadata pads inside the declared
/// length with NULs — trim them.
function borshString(data, offset) {
  if (!data || data.length < offset + 4) return [null, offset];
  const len = data.readUInt32LE(offset);
  if (data.length < offset + 4 + len) return [null, offset];
  const s = data.slice(offset + 4, offset + 4 + len).toString("utf8").replace(/\0+$/g, "");
  return [s, offset + 4 + len];
}

/// Minimal AssetV1 decode: key byte, 32-byte owner, update-authority enum,
/// then Borsh name + uri (the asset's own metadata pointer — used to
/// preserve metadata across the bridge when the deposit memo carries none).
/// (Layout per mpl-core: [key u8][owner pubkey][ua enum u8][ua pubkey?][name][uri]...)
function decodeCoreAsset(data, bs58) {
  if (!data || data.length < 34 || data[0] !== 1) return null; // 1 == AssetV1
  const owner = bs58.encode(data.slice(1, 33));
  const uaType = data[33]; // 0 None, 1 Address, 2 Collection
  const uaAddress =
    uaType !== 0 && data.length >= 66 ? bs58.encode(data.slice(34, 66)) : null;
  let off = uaType !== 0 ? 66 : 34;
  let name = null;
  let uri = null;
  [name, off] = borshString(data, off);
  if (name !== null) [uri] = borshString(data, off);
  return { owner, uaType, uaAddress, name, uri };
}

/// Minimal Metaplex Token Metadata decode (key 4 == MetadataV1):
/// [key u8][updateAuthority 32][mint 32][name][symbol][uri]... — enough to
/// recover the SPL NFT's metadata URI.
function decodeTokenMetadata(data) {
  if (!data || data.length < 66 || data[0] !== 4) return null;
  let off = 65;
  let name, symbol, uri;
  [name, off] = borshString(data, off);
  if (name === null) return null;
  [symbol, off] = borshString(data, off);
  if (symbol === null) return null;
  [uri] = borshString(data, off);
  return { name, symbol, uri };
}

const TOKEN_METADATA_PROGRAM_ID = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

class SolanaRpcAdapter {
  // escrowSecretKey (byte array) is only needed to SIGN releases. Read-only
  // consumers (custody checks in the guarded ops tools) pass escrowPubkey
  // (base58 string) instead so the cold escrow key never leaves its vault.
  constructor({ rpcUrl, escrowSecretKey, escrowPubkey, commitment = "finalized" }) {
    const { web3, bs58 } = lazyDeps();
    if (!rpcUrl) throw new Error("rpcUrl required");
    this.web3 = web3;
    this.bs58 = bs58;
    this.commitment = commitment;
    this.connection = new web3.Connection(rpcUrl, commitment);
    if (escrowSecretKey) {
      this.escrow = web3.Keypair.fromSecretKey(Uint8Array.from(escrowSecretKey));
      this.readOnly = false;
    } else if (escrowPubkey) {
      this.escrow = { publicKey: new web3.PublicKey(escrowPubkey) };
      this.readOnly = true;
    } else {
      throw new Error("escrowSecretKey (signing) or escrowPubkey (read-only) required");
    }
  }

  escrowPubkeyHex() {
    return "0x" + Buffer.from(this.escrow.publicKey.toBytes()).toString("hex");
  }

  _parseMemo(tx) {
    const all = [
      ...tx.transaction.message.instructions,
      ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions),
    ];
    for (const ix of all) {
      const pid = ix.programId ? ix.programId.toString() : ix.program;
      if (pid !== MEMO_PROGRAM_ID && ix.program !== "spl-memo") continue;
      const memo = typeof ix.parsed === "string" ? ix.parsed : null;
      if (!memo) continue;
      const m = memo.trim().match(/^(0x[0-9a-fA-F]{40})(?:\|(.*))?$/);
      if (m) return { recipientEvm: m[1], uri: m[2] ?? "" };
    }
    return null;
  }

  /// All signatures newer than `cursor`, newest first, PAGINATED. A single
  /// getSignaturesForAddress call caps at 1,000 — without pagination a burst
  /// of escrow-mentioning txs between ticks would silently drop the OLDEST
  /// (deposits buried under spam) while the cursor jumped to the newest.
  /// Failing loud on absurd depth keeps the fail-closed discipline.
  async _newSignatures(cursor) {
    const out = [];
    let before;
    for (let page = 0; page < 50; page++) {
      const batch = await this.connection.getSignaturesForAddress(
        this.escrow.publicKey,
        { limit: 1000, ...(cursor ? { until: cursor } : {}), ...(before ? { before } : {}) },
        this.commitment
      );
      out.push(...batch);
      if (batch.length < 1000) return out;
      before = batch[batch.length - 1].signature;
    }
    throw new Error("escrow signature history >50k since cursor — refusing to skip; investigate");
  }

  /// FINALIZED deposits into the escrow EOA, oldest first. Cursor is the
  /// newest processed signature (base58); only finalized history is scanned,
  /// so the cursor can never skip a deposit that later becomes visible.
  async fetchDeposits(cursor) {
    const sigs = await this._newSignatures(cursor);
    if (sigs.length === 0) return { deposits: [], cursor: cursor ?? null };
    const newestSig = sigs[0].signature;
    const deposits = [];
    for (const s of sigs.reverse()) {
      if (s.err) continue;
      const tx = await this.connection.getParsedTransaction(s.signature, {
        maxSupportedTransactionVersion: 0,
        commitment: this.commitment,
      });
      if (!tx || !tx.meta) throw new Error(`tx ${s.signature} not fetchable — retry tick`);
      const escrowB58 = this.escrow.publicKey.toBase58();
      // The deposited mint is whichever mint the escrow went 0 -> 1 on.
      const post = (tx.meta.postTokenBalances ?? []).filter(
        (b) => b.owner === escrowB58 && b.uiTokenAmount.amount === "1"
      );
      const preByMint = new Map(
        (tx.meta.preTokenBalances ?? [])
          .filter((b) => b.owner === escrowB58)
          .map((b) => [b.mint, b.uiTokenAmount.amount])
      );
      for (const b of post) {
        if ((preByMint.get(b.mint) ?? "0") !== "0") continue; // not a fresh deposit
        const memo = this._parseMemo(tx);
        if (!memo) continue; // parked without memo — manual ops path, never guessed
        const { web3 } = this;
        const md = await this._splMetadata(b.mint);
        deposits.push({
          sigHex: "0x" + Buffer.from(this.bs58.decode(s.signature)).toString("hex"),
          mintHex:
            "0x" + Buffer.from(new web3.PublicKey(b.mint).toBytes()).toString("hex"),
          recipientEvm: memo.recipientEvm,
          // Metadata preservation: memo URI wins; otherwise read the NFT's
          // own Token Metadata URI so the wrap always points at the real
          // metadata even when the depositing UI passes none. The name rides
          // along so the relayer's name-only fallback has something to show
          // when no usable URI survives sanitization.
          uri: memo.uri || md?.uri || "",
          name: md?.name || "",
        });
      }

      // Metaplex Core deposits: a Core TransferV1 in this tx whose asset
      // account is NOW owned (asset-level owner) by the escrow. Current-state
      // check is deliberate — a Core transfer since undone never mints.
      for (const assetB58 of this._coreTransferAssets(tx)) {
        const memo = this._parseMemo(tx);
        if (!memo) continue;
        const info = await this.connection.getAccountInfo(
          new this.web3.PublicKey(assetB58),
          this.commitment
        );
        if (!info || info.owner.toBase58() !== CORE_PROGRAM_ID) continue;
        const asset = decodeCoreAsset(info.data, this.bs58);
        if (!asset || asset.owner !== escrowB58) continue;
        deposits.push({
          sigHex: "0x" + Buffer.from(this.bs58.decode(s.signature)).toString("hex"),
          mintHex:
            "0x" +
            Buffer.from(new this.web3.PublicKey(assetB58).toBytes()).toString("hex"),
          recipientEvm: memo.recipientEvm,
          // Metadata preservation: memo URI wins; otherwise the Core asset's
          // own on-chain uri field rides into the wrap. Name rides along for
          // the relayer's name-only fallback.
          uri: memo.uri || asset.uri || "",
          name: asset.name || "",
        });
      }
    }
    // One deposit per (sig, asset) even if a tx matched both scan branches.
    const seen = new Set();
    const deduped = deposits.filter((d) => {
      const k = d.sigHex + d.mintHex;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    return { deposits: deduped, cursor: newestSig };
  }

  /// SPL NFT metadata ({uri, name}) from the Metaplex Token Metadata PDA.
  /// Best-effort: returns null when no metadata account exists (bare SPL
  /// token) — the deposit still mints, just with an empty URI.
  async _splMetadata(mintB58) {
    try {
      const { web3 } = this;
      const programId = new web3.PublicKey(TOKEN_METADATA_PROGRAM_ID);
      const [pda] = web3.PublicKey.findProgramAddressSync(
        [Buffer.from("metadata"), programId.toBytes(), new web3.PublicKey(mintB58).toBytes()],
        programId
      );
      const info = await this.connection.getAccountInfo(pda, this.commitment);
      if (!info) return null;
      const md = decodeTokenMetadata(info.data);
      if (!md) return null;
      return { uri: md.uri || null, name: md.name || null };
    } catch {
      return null; // metadata is best-effort; never block a deposit on it
    }
  }

  /// Asset accounts referenced by Core TransferV1 instructions in this tx
  /// (top-level + inner; marketplaces wrap the Core transfer).
  _coreTransferAssets(tx) {
    const out = new Set();
    const all = [
      ...tx.transaction.message.instructions,
      ...(tx.meta?.innerInstructions ?? []).flatMap((i) => i.instructions),
    ];
    for (const ix of all) {
      const pid = ix.programId ? ix.programId.toString() : null;
      if (pid !== CORE_PROGRAM_ID || !ix.data || !ix.accounts?.length) continue;
      let disc;
      try {
        disc = this.bs58.decode(ix.data)[0];
      } catch {
        continue;
      }
      if (disc !== CORE_TRANSFER_DISCRIMINATOR) continue;
      out.add(ix.accounts[0].toString());
    }
    return out;
  }

  /// Does the escrow CURRENTLY hold this asset? Checked by the relayer right
  /// before every mint — a wrap must never exist without its asset in
  /// custody. This is what makes stateless full-history rescans
  /// unconditionally safe: a stale deposit record for an asset that has
  /// since been released can never mint an unbacked wrap.
  async isInEscrow(mintHex) {
    const { web3, spl } = { web3: this.web3, spl: lazyDeps().spl };
    const mint = new web3.PublicKey(hexToBytes(mintHex));
    const info = await this.connection.getAccountInfo(mint, this.commitment);
    if (info && info.owner.toBase58() === CORE_PROGRAM_ID) {
      const decoded = decodeCoreAsset(info.data, this.bs58);
      return !!decoded && decoded.owner === this.escrow.publicKey.toBase58();
    }
    const escrowAta = spl.getAssociatedTokenAddressSync(mint, this.escrow.publicKey);
    const bal = await this.connection
      .getTokenAccountBalance(escrowAta, this.commitment)
      .catch(() => null);
    return !!bal && bal.value.amount === "1";
  }

  /// Transfer the escrowed NFT to `recipientHex` (32-byte pubkey). Idempotent.
  /// Routes by asset shape: Metaplex Core accounts release via mpl-core
  /// transferV1; everything else takes the classic SPL ATA path.
  async releaseNft(mintHex, recipientHex) {
    if (this.readOnly) throw new Error("adapter is read-only (no escrow secret key) — cannot release");
    const { web3, spl, bs58 } = { web3: this.web3, spl: lazyDeps().spl, bs58: this.bs58 };
    const mint = new web3.PublicKey(hexToBytes(mintHex));
    const recipient = new web3.PublicKey(hexToBytes(recipientHex));

    const mintInfo = await this.connection.getAccountInfo(mint, this.commitment);
    if (mintInfo && mintInfo.owner.toBase58() === CORE_PROGRAM_ID) {
      return this._releaseCoreAsset(mintInfo, mint, recipient, bs58);
    }

    const escrowAta = spl.getAssociatedTokenAddressSync(mint, this.escrow.publicKey);
    const recipientAta = spl.getAssociatedTokenAddressSync(mint, recipient, true);

    const escrowBal = await this.connection
      .getTokenAccountBalance(escrowAta, this.commitment)
      .catch(() => null);
    if (!escrowBal || escrowBal.value.amount !== "1") {
      const recBal = await this.connection
        .getTokenAccountBalance(recipientAta, this.commitment)
        .catch(() => null);
      if (recBal && recBal.value.amount === "1") {
        return { sigHex: null, alreadyReleased: true };
      }
      throw new Error(`escrow does not hold mint ${mintHex}`);
    }

    const ixs = [];
    const recInfo = await this.connection.getAccountInfo(recipientAta, this.commitment);
    if (!recInfo) {
      ixs.push(
        spl.createAssociatedTokenAccountInstruction(
          this.escrow.publicKey,
          recipientAta,
          recipient,
          mint
        )
      );
    }
    ixs.push(
      spl.createTransferCheckedInstruction(
        escrowAta,
        mint,
        recipientAta,
        this.escrow.publicKey,
        1n,
        0
      )
    );
    const sig = await web3.sendAndConfirmTransaction(
      this.connection,
      new web3.Transaction().add(...ixs),
      [this.escrow],
      { commitment: this.commitment }
    );
    return { sigHex: "0x" + Buffer.from(bs58.decode(sig)).toString("hex"), alreadyReleased: false };
  }

  /// Metaplex Core release: escrow signs as the asset owner and pays fees.
  /// Idempotent on the asset's CURRENT owner field.
  async _releaseCoreAsset(assetInfo, assetPk, recipient, bs58) {
    const decoded = decodeCoreAsset(assetInfo.data, bs58);
    if (!decoded) throw new Error(`account ${assetPk.toBase58()} is not an AssetV1`);
    if (decoded.owner === recipient.toBase58()) {
      return { sigHex: null, alreadyReleased: true };
    }
    if (decoded.owner !== this.escrow.publicKey.toBase58()) {
      throw new Error(`escrow does not hold core asset ${assetPk.toBase58()}`);
    }
    const { createUmi, mplCore, transferV1, keypairIdentity, publicKey } = lazyUmi();
    const umi = createUmi(this.connection.rpcEndpoint, {
      commitment: this.commitment,
    }).use(mplCore());
    umi.use(
      keypairIdentity(umi.eddsa.createKeypairFromSecretKey(Uint8Array.from(this.escrow.secretKey)))
    );
    const args = {
      asset: publicKey(assetPk.toBase58()),
      newOwner: publicKey(recipient.toBase58()),
    };
    // A collection-bound asset must pass its collection account.
    if (decoded.uaType === 2 && decoded.uaAddress) {
      args.collection = publicKey(decoded.uaAddress);
    }
    const res = await transferV1(umi, args).sendAndConfirm(umi, {
      confirm: { commitment: this.commitment },
    });
    return {
      sigHex: "0x" + Buffer.from(res.signature).toString("hex"),
      alreadyReleased: false,
    };
  }
}

module.exports = { SolanaRpcAdapter, decodeCoreAsset, decodeTokenMetadata };
