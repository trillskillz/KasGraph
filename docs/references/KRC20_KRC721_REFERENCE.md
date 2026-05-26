# KRC-20 and KRC-721 reference

Two eras of Kaspa token data exist in the wild today: **legacy inscription-style tokens** (deployed by Kasplex starting 2024) and **native covenant-based tokens** (the KCC20 family, post-Toccata, indexable via KIP-20 covenant ids). KasGraph indexes both so subgraphs can answer historical and forward-looking queries from a single API.

This doc is the guardrail for Phase 2.5 detector work and the Phase 6.3 / 6.4 reference subgraphs.

## The two eras at a glance

| Concern | Legacy (Kasplex inscription) | Native (KCC20 covenant) |
| --- | --- | --- |
| Activation | Mainnet 2024-ish (Kasplex deployment) | Toccata hard fork + KIP-20 covenants |
| Transport | Transaction payload inscriptions (Ordinals-style envelope) | KIP-20 covenants — script + state spliced into the redeem script |
| Identity | `tick` (4-char ASCII) | 32-byte covenant id (genesis output's KIP-20 id) |
| State | Reconstructed off-chain from the operation stream | Read directly from the on-chain script's state window |
| Authority | Honour system + Kasplex indexer rules | Consensus-enforced via covenant validation |
| Indexability | Off-chain inscription parser + supply ledger | Direct lineage walk of `(covenant_id, seq)` |
| Reorg cost | Re-parse all inscriptions in the affected blocks | Roll back lineage rows past unwind point (see `BLOCKDAG_REORG_SEMANTICS.md`) |

KasGraph indexes both into one unified `Token`, `TokenHolding`, `TokenTransfer` schema, with a `tokenStandard` enum field discriminating `LEGACY_KRC20`, `NATIVE_KCC20`, `LEGACY_KRC721`, `NATIVE_KRC721`. Subgraph authors writing for the native path get covenant-id queries; subgraph authors needing backwards-compat get the legacy view.

## Legacy KRC-20 (Kasplex inscription era)

### Inscription envelope shape

Kasplex KRC-20 operations are JSON inscriptions embedded in transaction payloads. The canonical envelope:

```json
{
  "p": "krc-20",
  "op": "deploy" | "mint" | "transfer" | "burn",
  "tick": "TICK",
  "max":  "<u64 string>",   // deploy only
  "lim":  "<u64 string>",   // deploy only, per-mint cap
  "amt":  "<u64 string>",   // mint/transfer/burn
  "to":   "kaspa:<addr>"    // transfer only (recipient)
}
```

The envelope lives in the transaction payload field (not in any script). Kasplex's reference indexer scans every transaction for `p == "krc-20"` payloads and applies them in transaction order.

### Indexer rules (Kasplex-compatible)

To stay compatible with the canonical Kasplex view, KasGraph implements the same acceptance rules:

1. **`deploy`** registers a `tick` if no prior `deploy` for that `tick` exists. First-writer-wins on the canonical VSPC. `max` and `lim` are immutable post-deploy.
2. **`mint`** credits `amt` to the sender (the transaction's first input's address — the standard Kasplex convention) iff `cumulative_minted + amt <= max` and `amt <= lim`. Over-cap mints are rejected wholesale; partial mints are not allowed.
3. **`transfer`** moves `amt` from sender to `to` iff `sender_balance >= amt`. Insufficient balance rejects.
4. **`burn`** decrements sender balance and `cumulative_minted` (some Kasplex variants don't decrement `cumulative_minted`; KasGraph mirrors the canonical Kasplex behaviour — verify against the Kasplex repo before shipping).

KasGraph re-derives these rules independently rather than trusting an external indexer, so a subgraph can run on a self-hosted KasGraph without an external dependency. The result must match Kasplex's indexer output block-for-block on mainnet — drift is treated as a bug.

### Edge cases

- **Reorgs** revert the inscription operations in reverse acceptance order. Because legacy KRC-20 state is purely a function of the accepted operation stream, the unwind procedure is "roll the ledger back to the pre-reorg point, then re-replay added blocks." The lineage-row model from `KIP20_COVENANT_ID_QUERIES.md` doesn't apply — we use a dedicated `kasgraph_krc20_legacy_ledger` table keyed on `(tick, accepting_block_hash, seq)`.
- **Malformed envelopes** (missing field, non-numeric `amt`, non-ASCII `tick`) are dropped silently. We log them at debug level for later reconciliation but they do not contribute to state.
- **Tick collisions** (case-folding, leading/trailing whitespace) — Kasplex normalises to lowercase ASCII. KasGraph does the same and exposes the original `tick` text in a `tickRaw` field for display purposes.

## Legacy KRC-721 (inscription era)

Inscription envelope is similar but with NFT semantics:

```json
{
  "p": "krc-721",
  "op": "deploy" | "mint" | "transfer" | "burn",
  "tick": "COLLECTION",
  "max": "<u64>",      // deploy only
  "id":  "<u64>",      // mint/transfer/burn — token id within collection
  "uri": "<string>",   // mint only, metadata uri
  "to":  "kaspa:..."   // transfer only
}
```

Acceptance rules mirror legacy KRC-20: deploy is first-writer-wins, mints require `id < max` and unique, transfers require current ownership. KasGraph indexes a `kasgraph_krc721_legacy_token` table keyed on `(tick, token_id)` with an owner column plus a `kasgraph_krc721_legacy_transfer` table for history.

## Native KCC20 (post-Toccata covenant era)

The KCC20 family — sourced from the sibling **OpenSilver** repo's `contracts/tokens/` — is the on-chain primitive that lets KRC-20 tokens live inside the consensus layer rather than as off-chain inscriptions.

### KCC20 architecture

A KCC20 token consists of **two** covenant instances:

1. **The asset covenant** (`contracts/tokens/kcc20.sil` in OpenSilver). One per token. Holds total supply, decimals, the controller pubkey, and an internal "mint nonce." All transfers, mints, and burns transition this covenant's state. Indexable by a single covenant id.
2. **A controller covenant** (`kcc20-ownable.sil`, `kcc20-pausable.sil`, `kcc20-capped.sil`, `kcc20-vesting.sil`). Optional. Bound to the asset covenant via `validateOutputStateWithTemplate`. Controls who can mint and under what conditions. The asset covenant defers minting authority to whichever controller's covenant id is recorded in its state.

For indexing purposes this means **two lineages** per token: the asset's lineage (every supply change), and the controller's lineage (every authority rotation, pause/unpause, cap remaining, etc.). KasGraph indexes both and exposes them as `Token { id, assetCovenantId, controllerCovenantId, controllerKind }`.

### Per-holder balances

Native KCC20 does **not** store a global balance table on chain. Instead each holder has an individual **balance receipt** UTXO whose script binds (asset_covenant_id, holder_pubkey, amount) and whose redemption rules require co-spending with the asset covenant. KasGraph indexes balance-receipt UTXOs in their own table:

```sql
CREATE TABLE kasgraph_kcc20_balance (
    asset_covenant_id BYTEA NOT NULL,
    holder_pubkey     BYTEA NOT NULL,
    amount            NUMERIC(78,0) NOT NULL,   -- supports up to ~u256
    current_utxo      BYTEA NOT NULL,           -- tx_hash || output_idx
    last_seen_daa     BIGINT NOT NULL,
    PRIMARY KEY (asset_covenant_id, holder_pubkey)
);
```

When a transfer happens, the sender's balance receipt is spent and replaced with a lower-amount receipt; a new receipt is created for the recipient. KasGraph updates both rows in the same SQL transaction. Aggregations ("how many holders does this token have?") are a `COUNT(*) WHERE asset_covenant_id = $1`.

### Controller variants

Recognising which controller is in use is the job of `kasgraph-detectors`. The variants:

| Controller | OpenSilver pattern | What it does | Detector key |
| --- | --- | --- | --- |
| Ownable | `krc20.kcc20-ownable` | Single owner can mint and rotate controller. Two-step admin handoff. | `KCC20OwnableController` |
| Pausable | `krc20.kcc20-pausable` | Owner can pause new mints; transfers continue. | `KCC20PausableController` |
| Capped | `krc20.kcc20-capped` | Decremented remaining-allowance state budget. Mints fail when the cap is exhausted. | `KCC20CappedController` |
| Vesting | `krc20.kcc20-vesting` | Time-locked mint release schedule. | `KCC20VestingController` |

Each controller's compiled script has a stable byte prefix (the entry-point logic) and a per-instance state window (owner pubkey, paused flag, remaining budget, vesting schedule). Detection works by fingerprinting the byte prefix with the state window masked out — see Phase 2.5 below.

### Cross-covenant binding (asset ↔ controller)

The asset covenant's state includes the controller covenant's id. When a controller rotates (Ownable handoff, controller swap), the asset's lineage records a transition with `state_bytes` reflecting the new controller id. The indexer must therefore:

1. Watch the asset's lineage for controller-id state-byte changes.
2. Record each `(asset_covenant_id, controller_covenant_id, valid_from_daa, valid_to_daa)` window in `kasgraph_kcc20_controller_binding`.
3. Resolve "who controls this token right now" as `WHERE asset_covenant_id = $1 AND valid_to_daa IS NULL`.

This is the same shape used by `kasgraph_covenant_binding` in `KIP20_COVENANT_ID_QUERIES.md` — KCC20 binding is a typed view over the generic covenant-binding mechanism.

## Native KRC-721 (post-Toccata covenant era)

The native KRC-721 design follows KCC20 in spirit:

- **Collection covenant** — one per collection. Holds collection-level metadata: max supply, mint authority controller, base metadata URI prefix.
- **Per-NFT covenant** — one per minted token. Genesis is the collection's mint operation; lineage tracks ownership transitions. The covenant id is permanent and uniquely names the token across its lifetime.

The indexer's job:

| Entity | Source | KasGraph table |
| --- | --- | --- |
| Collection-level state | Collection covenant lineage | `kasgraph_krc721_native_collection` |
| Per-NFT ownership | Per-NFT covenant lineage | `kasgraph_krc721_native_token` (current owner, current_utxo) plus a `_transfer` history table joined on `(collection_covenant_id, token_id)` |
| Metadata URI | Spliced into the per-NFT covenant's state window at mint | `metadata_uri` column on the token row |

Per-NFT transfers are then just lineage transitions on the per-NFT covenant. "Has this NFT ever been transferred?" is `SELECT COUNT(*) > 1 FROM kasgraph_covenant_lineage_row WHERE covenant_id = $1`. "Who owns it now?" is `kasgraph_covenant_lineage_head.current_utxo`'s associated address.

The native KRC-721 spec is still in flux at time of writing (krc721.stream maintainers are the canonical source). KasGraph commits to whichever shape ships in the launch ecosystem call; the schema above is what we'll likely converge on based on the OpenSilver pattern family.

## Aggregated views

For every token KasGraph exposes:

```graphql
type Token {
  id: ID!                          # canonical id: "legacy:TICK" or "native:0x<covenantId>"
  standard: TokenStandard!         # LEGACY_KRC20 | NATIVE_KCC20 | LEGACY_KRC721 | NATIVE_KRC721
  name: String
  symbol: String
  decimals: Int!
  totalSupply: BigInt!
  holderCount: Int!
  controllerKind: KCC20ControllerKind  # native only
  assetCovenantId: String              # native only
  controllerCovenantId: String         # native only
  recentTransfers(first: Int = 25): [TokenTransfer!]!
}
```

Subgraphs subscribe to `TokenTransfer` events without needing to know whether the underlying source is an inscription or a covenant lineage transition.

## Detector matchers to produce (Phase 2.5)

Per `crates/kasgraph-detectors/src/lib.rs`:

- `KCC20Asset` — fingerprint the asset script prefix, mask the supply/controller-id state window.
- `KCC20OwnableController` — controller prefix, mask owner-pubkey + pending-owner state window.
- `KCC20PausableController` — controller prefix, mask owner + paused-flag state window.
- `KCC20CappedController` — controller prefix, mask owner + remaining-allowance state window.
- `KCC20VestingController` — controller prefix, mask owner + vesting schedule state window.
- `Krc721Collection` — both legacy inscription envelopes and native collection covenants share the kind.
- `Krc721Nft` — per-NFT covenant prefix, mask metadata-uri + owner state window.

Each matcher ships with a unit test against a fixture compiled script (real OpenSilver bytes wire in via `cargo xtask sync-opensilver-fingerprints` once available).

## Reference subgraphs to ship (PLAN.md Phase 6)

- `examples/krc20/` — both legacy and native variants. Demonstrates: holder list, top-N by balance, transfer feed, controller history.
- `examples/krc721/` — collection floor, per-token provenance, holder-of-most query, metadata-uri resolution.

## Source-of-truth

- **Legacy KRC-20**: Kasplex reference indexer — `https://github.com/kasplex/`. Open-source code review pending (Phase 1.3). Treat their on-mainnet output as the canonical expected ledger and reconcile on drift.
- **krc721.stream**: maintainer outreach pending (Phase 0). Their indexer logic is the canonical expected output for legacy KRC-721.
- **Native KCC20**: sibling OpenSilver repo `contracts/tokens/`. Five controller variants ship runtime-verified. The pattern catalogue at `artifacts/manifests/ide-all.json` enumerates the canonical pattern ids.
- **Native KRC-721**: in flux; tracked via the Kaspa Foundation discussion channel and the OpenSilver pattern roadmap.
- Cross-references: `KIP20_COVENANT_ID_QUERIES.md` (covenant-id model), `BLOCKDAG_REORG_SEMANTICS.md` (unwind procedure), `THEGRAPH_REFERENCE.md` (mapping shape).
