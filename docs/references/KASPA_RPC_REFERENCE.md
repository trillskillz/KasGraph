# Kaspa RPC reference

Status: **deep-dive draft landed**. This doc captures the Kaspa RPC surface KasGraph actually needs for Phase 2.2 and 2.3, plus the shapes exposed by `rusty-kaspa`'s RPC model types.

## Scope

This is the RPC contract between KasGraph and Kaspa nodes.

It focuses on:

- the read methods KasGraph needs for block ingestion, health checks, reorg recovery, UTXO lookups, and mempool enrichment
- the notification methods KasGraph needs for continuous BlockDAG ingestion
- the exact data carried by `RpcBlock`, `RpcHeader`, `RpcTransaction`, `RpcUtxoEntry`, and related response types
- how KasGraph's current `crates/kasgraph-rpc/` scaffold maps onto the upstream surface today

## Source of truth

Primary upstream references:

- `kaspanet/rusty-kaspa` `rpc/core/src/api/ops.rs`
- `kaspanet/rusty-kaspa` `rpc/core/src/model/message.rs`
- `kaspanet/rusty-kaspa` `rpc/core/src/model/block.rs`
- `kaspanet/rusty-kaspa` `rpc/core/src/model/header.rs`
- `kaspanet/rusty-kaspa` `rpc/core/src/model/tx.rs`
- `kaspanet/rusty-kaspa` `rpc/core/src/model/address.rs`
- `kaspanet/rusty-kaspa` `rpc/core/src/model/mempool.rs`
- `https://docs.kaspa.org/`

When this doc disagrees with upstream Rust types, upstream wins.

## RPC operation catalog relevant to KasGraph

From `RpcApiOps`, the methods and notifications that matter most are:

### Read methods

- `GetServerInfo`
- `GetSyncStatus`
- `GetCurrentNetwork`
- `GetBlock`
- `GetBlocks`
- `GetBlockDagInfo`
- `GetVirtualChainFromBlock`
- `GetVirtualChainFromBlockV2`
- `GetHeaders`
- `GetUtxosByAddresses`
- `GetBalanceByAddress`
- `GetBalancesByAddresses`
- `GetMempoolEntry`
- `GetMempoolEntries`
- `GetMempoolEntriesByAddresses`
- `GetDaaScoreTimestampEstimate`
- `GetUtxoReturnAddress`
- `GetMetrics`

### Notification subscriptions

- `NotifyBlockAdded`
- `NotifyVirtualChainChanged`
- `NotifyUtxosChanged`
- `NotifyVirtualDaaScoreChanged`
- `NotifyFinalityConflict`
- `NotifyFinalityConflictResolved`
- `NotifyPruningPointUtxoSetOverride`
- `NotifySinkBlueScoreChanged`
- `NotifyNewBlockTemplate`

### What KasGraph uses first

For the Phase 2 indexer, the critical minimum set is:

1. `GetServerInfo`
2. `GetBlockDagInfo`
3. `GetBlock`
4. `GetVirtualChainFromBlock` or `GetVirtualChainFromBlockV2`
5. `NotifyBlockAdded`
6. `NotifyVirtualChainChanged`
7. `GetUtxosByAddresses`
8. `GetMempoolEntries` / `GetMempoolEntriesByAddresses`

Everything else is enrichment, operator visibility, or future-proofing.

## Health / capability probes

### `GetServerInfo`

`GetServerInfoResponse` carries:

- `rpc_api_version`
- `rpc_api_revision`
- `server_version`
- `network_id`
- `has_utxo_index`
- `is_synced`
- `virtual_daa_score`

This is the best first handshake for KasGraph because it answers three gating questions immediately:

- are we speaking a compatible RPC API version?
- is the node on the network we expect?
- does the node have the UTXO index required for address-centric enrichment?

### `GetBlockDagInfo`

`GetBlockDagInfoResponse` carries:

- `network`
- `block_count`
- `header_count`
- `tip_hashes`
- `difficulty`
- `past_median_time`
- `virtual_parent_hashes`
- `pruning_point_hash`
- `virtual_daa_score`
- `sink`

KasGraph should use this for:

- one-shot endpoint health checks
- chain-tip liveness
- lag measurement
- anchoring recovery windows
- comparing multiple RPC sources during failover

**Current scaffold note:** `crates/kasgraph-rpc` already uses `getBlockDagInfo` as its health probe payload.

## Block reads

### `GetBlock`

`GetBlockRequest`:

- `hash`
- `include_transactions`

`GetBlockResponse` returns `block: RpcBlock`.

KasGraph uses this for:

- fetching exact blocks named in a notification
- replaying removed / re-added virtual-chain segments
- filling gaps after a dropped subscription or failover
- deterministic ordering in a recovery pass

**Current scaffold note:** `crates/kasgraph-rpc` already issues `getBlock` with `includeTransactions: true` and maps the result into `IngestedBlock`.

### `GetBlocks`

`GetBlocksRequest`:

- `low_hash: Option<RpcHash>`
- `include_blocks: bool`
- `include_transactions: bool`

`GetBlocksResponse`:

- `block_hashes`
- `blocks`

This is useful when KasGraph wants a wider contiguous catch-up window instead of per-hash fetches, though the current scaffold does not consume it yet.

## Virtual-chain recovery

### `GetVirtualChainFromBlock`

`GetVirtualChainFromBlockRequest`:

- `start_hash`
- `include_accepted_transaction_ids`
- `min_confirmation_count: Option<u64>`

`GetVirtualChainFromBlockResponse`:

- `removed_chain_block_hashes`
- `added_chain_block_hashes`
- `accepted_transaction_ids`

This is the key recovery primitive for BlockDAG-safe indexing.

It answers: "since block X, what left the selected chain, what joined it, and optionally which transactions became accepted in each accepting block?"

KasGraph should use it for:

- recovering after websocket disconnects
- reconciling failover between RPC endpoints
- rolling back selected-chain state safely
- replaying only the changed window instead of rescanning blindly

### `GetVirtualChainFromBlockV2`

`GetVirtualChainFromBlockV2Request`:

- `start_hash`
- `data_verbosity_level: Option<RpcDataVerbosityLevel>`
- `min_confirmation_count: Option<u64>`

`GetVirtualChainFromBlockV2Response`:

- `removed_chain_block_hashes`
- `added_chain_block_hashes`
- `chain_block_accepted_transactions`

The V2 shape is better for richer recovery because it can carry optional block / transaction bodies instead of only hashes and accepted txid lists.

## Subscription pattern KasGraph should follow

The reliable ingestion pattern is:

1. handshake with `GetServerInfo`
2. snapshot tip with `GetBlockDagInfo`
3. issue generic `subscribe` for `BlockAdded`
4. issue generic `subscribe` for `VirtualChainChanged`
5. optionally subscribe to `VirtualDaaScoreChanged` for operator metrics
6. on any socket drop or suspected gap, recover from the last durable selected-chain anchor using `GetVirtualChainFromBlock` or `V2`
7. re-fetch missing blocks with `GetBlock` / `GetBlocks`
8. only commit blocks after KasGraph's own finality threshold policy says they are safe

### Why both notifications matter

- `BlockAdded` tells us a block entered the DAG, even if it is not on the selected chain yet.
- `VirtualChainChanged` tells us selected-chain membership changed.

KasGraph needs both because it is a BlockDAG indexer, not a simple longest-chain follower.

### Notification payloads

#### Live wRPC JSON shape validated against a real mainnet node

Validated reachable endpoint from this environment:

- `wss://eric.kaspa.stream/kaspa/mainnet/wrpc/json`

Validated subscribe requests:

```json
{"jsonrpc":"2.0","id":1,"method":"subscribe","params":{"BlockAdded":{}}}
{"jsonrpc":"2.0","id":2,"method":"subscribe","params":{"VirtualChainChanged":{"include_accepted_transaction_ids":false}}}
```

Validated subscribe acknowledgement shape:

```json
{"id":1,"method":"subscribe","params":{"id":5463}}
```

Validated point-call response shape on the same websocket path:

```json
{"id":3,"method":"getBlockDagInfo","params":{...}}
{"id":4,"method":"getBlock","params":{"block":{...}}}
{"id":5,"method":"getVirtualChainFromBlock","params":{"addedChainBlockHashes":[...],"removedChainBlockHashes":[...]}}
```

Validated capability-probe responses on the same websocket path:

```json
{"id":1,"method":"getServerInfo","params":{"networkId":"mainnet","rpcApiVersion":1,"rpcApiRevision":0,"serverVersion":"1.0.1","isSynced":true,"hasUtxoIndex":true,"virtualDaaScore":...}}
{"id":2,"method":"getInfo","params":{"serverVersion":"1.0.1","isSynced":true,"hasMessageId":true,"hasNotifyCommand":true,"isUtxoIndexed":true,...}}
```

Validated notification envelope shapes:

```json
{"method":"blockAddedNotification","params":{"BlockAdded":{"block":{...}}}}
{"method":"virtualChainChangedNotification","params":{"VirtualChainChanged":{"removedChainBlockHashes":[],"addedChainBlockHashes":[]}}}
```

This means KasGraph should not call `notifyBlockAdded` / `notifyVirtualChainChanged` as direct RPC methods on live JSON wRPC nodes. The upstream client uses the generic `subscribe` / `unsubscribe` RPC ops with serialized scope payloads. It also means a public JSON wRPC websocket can serve both streaming notifications and point RPC reads, so KasGraph does not need a separate HTTP endpoint just to hydrate `addedChainBlockHashes` or call `getVirtualChainFromBlock`.

Practical follow-through now landed in-repo:

- `kasgraph-rpc` explicitly initializes rustls before websocket connects so `wss://` public nodes work without external helper scripts.
- `crates/kasgraph-rpc/examples/live_wrpc_smoke.rs` can probe capabilities and capture a small notification sample from a real node.
- `crates/kasgraph-rpc/examples/continuous_wrpc_smoke.rs` exercises the reconnect-capable continuous driver without requiring Postgres and now supports duration-based soak runs with reconnect/high-water summaries plus optional JSON summary artifacts.
- `kasgraph-rpc` now exposes `SubscriptionDriverEvent` plus `spawn_continuous_subscription_with_events(...)` so integration/smoke code can observe connect/reconnect/gap/stop events directly.
- Real smoke runs against `wss://eric.kaspa.stream/kaspa/mainnet/wrpc/json` from this environment captured both `BlockAdded` and `VirtualChainChanged` notifications; the first 60-second, 5-minute, and 15-minute soaks all completed with zero reconnects and zero `RecoveryRequired` notifications.
- Reconnect gap detection was hardened so stale replay or overlapping old/new DAA payloads after reconnect do not accidentally clear the pending recovery check before the first truly new DAA arrives.

#### `BlockAdded`

Subscribe payload:

- `{"BlockAdded": {}}`

Notification payload:

- `block: RpcBlock`

This is a DAG-arrival signal, not a finality signal.

#### `VirtualChainChanged`

Subscribe payload:

- `{"VirtualChainChanged": {"include_accepted_transaction_ids": bool}}`

Notification payload:

- `removedChainBlockHashes`
- `addedChainBlockHashes`
- `acceptedTransactionIds`

This is the selected-chain delta stream and the most important reorg signal.

## Core data models KasGraph consumes

### `RpcHeader`

`RpcHeader` contains:

- `hash`
- `version`
- `parents_by_level`
- `hash_merkle_root`
- `accepted_id_merkle_root`
- `utxo_commitment`
- `timestamp`
- `bits`
- `nonce`
- `daa_score`
- `blue_work`
- `blue_score`
- `pruning_point`

For KasGraph, the most important fields are:

- `hash` for identity
- `parents_by_level` for DAG linkage
- `daa_score` for ordering / finality windows
- `blue_score` for progress metrics and tie-breaking context
- `accepted_id_merkle_root` because accepted-transaction views matter for app-level indexing
- `utxo_commitment` because KasGraph is UTXO-native infrastructure

### `RpcBlock`

`RpcBlock` contains:

- `header: RpcHeader`
- `transactions: Vec<RpcTransaction>`
- `verbose_data: Option<RpcBlockVerboseData>`

`RpcBlockVerboseData` includes:

- `hash`
- `difficulty`
- `selected_parent_hash`
- `transaction_ids`
- `is_header_only`
- `blue_score`
- `children_hashes`
- `merge_set_blues_hashes`
- `merge_set_reds_hashes`
- `is_chain_block`

That verbose section is especially useful for:

- selected-parent inspection
- merge-set-aware observability
- confirming whether a block is on the selected chain right now

### `RpcTransaction`

`RpcTransaction` contains:

- `version`
- `inputs`
- `outputs`
- `lock_time`
- `subnetwork_id`
- `gas`
- `payload`
- `mass`
- `verbose_data`

`RpcTransactionVerboseData` includes:

- `transaction_id`
- `hash`
- `compute_mass`
- `block_hash`
- `block_time`

This matters for KasGraph because transaction `payload` is where app-level data, inscription-era envelopes, and future token metadata can surface. The RPC layer does not interpret that payload for us; KasGraph must.

### `RpcUtxoEntry`

`RpcUtxoEntry` contains:

- `amount`
- `script_public_key`
- `block_daa_score`
- `is_coinbase`

`GetUtxosByAddresses` returns `RpcUtxosByAddressesEntry`:

- `address`
- `outpoint`
- `utxo_entry`

This is the primary address-indexed enrichment surface for:

- wallet views
- covenant balance lookups
- token holder materialization
- cross-checking detector output against current spendable state

## Mempool surfaces

### `GetMempoolEntries`

Request:

- `include_orphan_pool`
- `filter_transaction_pool`

Response:

- `mempool_entries: Vec<RpcMempoolEntry>`

Each `RpcMempoolEntry` contains:

- `fee`
- `transaction: RpcTransaction`
- `is_orphan`

### `GetMempoolEntriesByAddresses`

This is the address-scoped mempool view. It is useful for pre-confirmation UX and monitoring, but it should stay clearly separate from durable indexed state.

## KIP-20 / covenant context exposed by RPC

The RPC surface does **not** expose a first-class `covenant_id` field in the block / tx model types consumed here.

What it does expose is enough for KasGraph to derive covenant lineage:

- transaction inputs and previous outpoints
- transaction outputs and script public keys
- `accepted_id_merkle_root` on headers
- selected-chain change feeds
- address / UTXO lookup primitives

So the RPC layer gives KasGraph the raw material, but **KasGraph must compute and persist the covenant lineage model itself**.

That is why `kasgraph-store` has dedicated lineage tables rather than expecting RPC to serve lineage directly.

## Native KRC-20 and legacy KRC-721 visibility

### What the RPC layer gives us

At RPC level, token-like and inscription-like activity appears as ordinary transactions with:

- standard inputs / outputs
- script public keys on outputs
- optional bytes in `payload`

### What the RPC layer does not give us

The RPC model does not decode for us:

- native KRC-20 semantic events
- legacy KRC-721 inscription envelopes
- OpenSilver fingerprints
- KasBonds-specific covenant semantics

That decoding belongs in KasGraph detectors and mapping code.

### Practical implication for KasGraph

- `kasgraph-rpc` should stay transport-focused
- token / covenant interpretation should live in `kasgraph-detectors` and `kasgraph-mapping`
- any future doc on KRC-20 / KRC-721 semantics should treat RPC as the byte carrier, not the semantic layer

## Current KasGraph implementation status vs upstream surface

### Already implemented in `crates/kasgraph-rpc`

- multi-endpoint config with primary-first failover
- backup rotation between calls
- `getBlock` fetches
- `getBlockDagInfo` health probes
- per-block audit memory (`served_by`, hash, DAA score)
- JSONL parsing into a local `ChainNotification` abstraction
- websocket text / binary message intake for line-delimited notification payloads
- hash-ordered recovery helper via `recover_blocks_by_hashes`

### Not implemented yet

- longer-run live validation of reconnect behavior against real public nodes
- `GetVirtualChainFromBlock` / `V2` recovery calls against a live node under real reconnect/reorg traces beyond one-shot probes
- removed-chain rollback of already-committed state
- mempool and UTXO enrichment calls
- policy decisions on how strict capability-gating should be for unsynced nodes versus merely warning
- optional persisted per-event reconnect/gap logs from soak runs so long sessions can be analyzed without preserving the full console transcript

## Recommended Phase 2.3 build order

1. Add a real `GetServerInfo` / `GetInfo` probe and fail fast on incompatible advertised capabilities.
2. Keep the now-validated generic `subscribe` JSON path covered with regression tests and a longer-running live smoke.
3. Track the last durable selected-chain anchor hash in storage.
4. On reconnect, call `GetVirtualChainFromBlock` from that anchor.
5. Replay removed blocks first, then added blocks, then persist a fresh POI checkpoint.
6. Add `GetUtxosByAddresses` enrichment for address and covenant-centric subgraphs.
7. Add `GetMempoolEntriesByAddresses` only after durable chain ingestion is solid.

## KasGraph-specific takeaways

- KasGraph should treat `BlockAdded` as probabilistic DAG intake.
- KasGraph should treat `VirtualChainChanged` as the selected-chain truth source.
- DAA score is the core ordering / recovery coordinate.
- `GetVirtualChainFromBlock` is the recovery primitive that makes failover sane.
- RPC gives us raw UTXO and transaction bytes, not covenant semantics.
- KIP-20 lineage, native token semantics, and pattern detection are KasGraph responsibilities above the transport.

## Open questions to close later

- which exact wRPC framing KasGraph should prefer in production: native Borsh, JSON wRPC, or an internal bridge
- whether `GetVirtualChainFromBlockV2` is mature enough to standardize on immediately
- the exact native KRC-20 post-Toccata payload schema once final upstream docs settle
- whether any upstream RPC field will eventually expose first-class covenant metadata directly

## Cross-reference

- `docs/references/KIP20_COVENANT_ID_QUERIES.md`
- `docs/references/BLOCKDAG_REORG_SEMANTICS.md`
- `crates/kasgraph-rpc/src/lib.rs`
- `crates/kasgraph-node/src/main.rs`
