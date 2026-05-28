# Native KRC-721 reference subgraph

Phase 6.4 from `PLAN.md`. Indexes the native post-Toccata KRC-721
family: collection covenants and the per-NFT covenants minted under
them.

## Covenant-aware, lineage-backed

Unlike an inscription indexer, this subgraph models NFTs the way
they actually live on-chain (see
`docs/references/KRC20_KRC721_REFERENCE.md`):

- **Collection covenant** — one per collection. Holds max supply,
  mint authority, base metadata URI.
- **Per-NFT covenant** — one per minted token. Its covenant id is
  the permanent, unique name of that token. Ownership is the head
  of the covenant's lineage; "has this NFT ever moved?" is just a
  lineage row count.

## Complements krc721.stream

krc721.stream is the canonical aggregated view for legacy
(inscription-era) KRC-721. This subgraph covers the native
covenant era and adds covenant-aware queries — provenance,
per-token lineage, and mint-authority tracking — that a flat
inscription index can't answer.

## Spec status

The native KRC-721 spec is still firming up (krc721.stream
maintainers + the Kaspa Foundation channel are canonical). The
schema here is the OpenSilver-aligned shape we expect to converge
on; the `krc721` data-source kind abstracts the underlying
collection/per-NFT covenant lineage so the schema stays stable
even as the wire format settles.
