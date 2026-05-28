# ZK Proofs and Witnesses reference subgraph

Phase 6.6 from `PLAN.md`. Indexes on-chain ZK proofs per KIP-16:
Groth16 proofs carried in covenant spends, their verifying keys,
public inputs, and witness data. Foundation for vProgs queries.

## Model

- **ZkVerifyingKey** — registered when a ZK-aware covenant is
  locked. The lock script pins the scheme, circuit hash, and
  public-input arity, so the key is keyed on the covenant id.
- **ZkProof** — one per proven spend. Holds the proof bytes and
  public inputs; links back to its verifying key.
- **ZkWitness** — witness blobs are bulky, so the bytes live in
  object storage (S3 or compatible, per PLAN.md Task 2.7) and the
  row keeps the storage URI, length, and sha256.
- **ZkVerification** — the verify outcome (and verifier version)
  recorded at index time, so queries don't re-run the verifier.

## Storage split

Proofs and metadata go to primary (Postgres) storage; witness
blobs go to object storage referenced by URI. This matches the
Phase 2.7 indexer design and keeps the queryable surface small
while still making every witness retrievable.

## Pattern status

The ZK-aware detector patterns (`ZkVerifierGroth16`,
`ZkRollupCommit`, `ZkPrivateTransfer`) are the committed selector
names; their registry entries land once OpenSilver exports its
ZK-aware pattern family. The schema and handlers here are stable
ahead of that — only the detector bytes are pending, exactly as
with the rest of `crates/kasgraph-detectors`.
