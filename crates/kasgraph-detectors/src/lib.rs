//! kasgraph-detectors — Built-in pattern detection for KasGraph.
//!
//! Per `PLAN.md` Phase 2.5: subgraphs do NOT write detection code.
//! They subscribe to typed events emitted by these detectors.
//!
//! Detector kinds:
//!   - OpenSilver patterns (Vault, Escrow, MultiSig, Vesting,
//!     StreamingPayment, AtomicSwap, DeadMansSwitch, SocialRecovery,
//!     FreelancePayroll, Ownable, TimeLock)
//!   - KCC20 (native KRC-20 post-Toccata) — asset + four controllers
//!   - ZK-aware family (verified-computation, private-asset-transfer,
//!     oracle, proof-stitched multi-pattern)
//!   - KRC721 collections + individual NFTs
//!   - KasBonds bonds (first dogfooding customer)
//!
//! Detectors operate on parsed redeem scripts. Each emits a
//! `DetectedPattern` event that the mapping runtime routes to
//! subgraph handlers.
//!
//! # Fingerprint model
//!
//! A pattern's compiled redeem script is mostly fixed bytes (the
//! entry-point logic) interspersed with per-instance state (owner
//! pubkey, paused flag, remaining allowance, vesting schedule, …).
//! A [`Fingerprint`] captures the canonical bytes and the
//! `masked_windows` that vary per instance. Matching ignores the
//! masked bytes; extraction pulls them out as named fields.
//!
//! Real OpenSilver compiled-script bytes wire into the
//! [`registry`] without touching the engine.

pub mod fingerprint;
pub mod krc20;
pub mod krc20_ledger;
pub mod registry;

pub use fingerprint::{Fingerprint, MaskedWindow};
pub use krc20::{parse_krc20_inscription, Krc20Inscription, Krc20Op, Krc20Parse};
pub use krc20_ledger::{ApplyOutcome, Krc20Ledger, TokenState};

use blake2::{digest::consts::U32, Blake2b, Digest};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Domain tag for covenant-id hashing. Keeps the id from colliding with
/// other blake2b uses in the project (e.g. POI), and is versioned so a
/// future change to the recipe is distinguishable.
const COVENANT_ID_DOMAIN: &[u8] = b"kasgraph.covenant_id.v1";

/// Deterministic covenant id for a lineage genesis outpoint.
///
/// Kaspa RPC does not expose covenant ids (see
/// `docs/references/KASPA_RPC_REFERENCE.md`); KasGraph computes and
/// persists the lineage model itself. The id is the blake2b-256 of the
/// genesis outpoint `(genesis_tx, genesis_output)`, domain-separated and
/// hex-encoded (64 chars). It is established once at genesis and stays
/// stable across every transition in the covenant's lineage — each spend
/// of a covenant UTXO inherits the predecessor's id rather than computing
/// a new one. This is the value carried in the `covenant_id` field on
/// detector hits and store rows.
pub fn genesis_covenant_id(genesis_tx: &str, genesis_output: u32) -> String {
    let mut hasher = Blake2b::<U32>::new();
    hasher.update(COVENANT_ID_DOMAIN);
    hasher.update(genesis_tx.as_bytes());
    hasher.update(genesis_output.to_be_bytes());
    hex::encode(hasher.finalize())
}

/// What we look for. Extensible — adding a variant requires adding a
/// matcher entry in [`registry::all`] and a unit test.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Hash, Serialize, Deserialize)]
pub enum DetectorKind {
    // OpenSilver covenant patterns. The OpenSilver SDK exposes
    // canonical compiled scripts; KasGraph fingerprints those to
    // recognise instances on-chain.
    OpenSilverOwnable,
    OpenSilverMultisig,
    OpenSilverTimeLock,
    OpenSilverVault,
    OpenSilverEscrowBilateral,
    OpenSilverEscrowMilestone,
    OpenSilverStreamingPayment,
    OpenSilverVesting,
    OpenSilverDeadMansSwitch,
    OpenSilverSocialRecovery,
    OpenSilverAtomicSwapHTLC,
    OpenSilverFreelancePayroll,

    // Native KRC-20 (post-Toccata).
    KCC20Asset,
    KCC20OwnableController,
    KCC20PausableController,
    KCC20CappedController,
    KCC20VestingController,

    // ZK-aware family.
    ZkVerifiedComputation,
    ZkPrivateAssetTransfer,
    ZkVerifiedOracle,
    ZkVerifiedOracleV2,
    ZkProofStitchedMultiPattern,

    // Legacy / non-covenant. Still indexed but with different
    // detection heuristics (inscription-envelope parsing).
    Krc721Collection,
    Krc721Nft,

    // First dogfooding customer.
    KasBondsBond,
}

/// What a detector emits when it matches.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DetectedPattern {
    pub kind: DetectorKind,
    /// KIP-20 covenant ID for the matched UTXO, hex-encoded. Stable
    /// across the covenant's lineage — same id across every spend.
    pub covenant_id: Option<String>,
    /// Transaction hash where the match was observed, hex-encoded.
    pub tx_hash: String,
    /// Output index inside that transaction.
    pub output_index: u32,
    /// Detector-specific structured payload (entry-point name, state
    /// fields decoded from the redeem script, etc.). Keys come from
    /// the matching fingerprint's `masked_windows[*].field` names.
    pub payload: serde_json::Value,
}

/// Detector pipeline entry point. Walks the registry; returns every
/// matching pattern (a single redeem script could legitimately match
/// more than one fingerprint — e.g. a KCC20 asset that also matches
/// a generic Ownable wrapper).
pub fn detect_in_output(
    redeem_script_bytes: &[u8],
    tx_hash: &str,
    output_index: u32,
) -> Vec<DetectedPattern> {
    let mut hits = Vec::new();
    for entry in registry::all() {
        if let Some(payload) = entry.fingerprint.match_and_extract(redeem_script_bytes) {
            hits.push(DetectedPattern {
                kind: entry.kind,
                covenant_id: None,
                tx_hash: tx_hash.to_owned(),
                output_index,
                payload: payload_to_json(payload),
            });
        }
    }
    hits
}

fn payload_to_json(payload: BTreeMap<&'static str, Vec<u8>>) -> serde_json::Value {
    let mut map = serde_json::Map::with_capacity(payload.len());
    for (field, bytes) in payload {
        map.insert(
            field.to_owned(),
            serde_json::Value::String(hex::encode(bytes)),
        );
    }
    serde_json::Value::Object(map)
}

/// One named state field a detector extracts, with the byte width of
/// its masked window. Surfaced hex-encoded at runtime (see
/// [`payload_to_json`]), so downstream codegen maps every field to a
/// hex string.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DetectorFieldSchema {
    pub name: String,
    pub byte_len: usize,
}

/// The extraction schema for one registered detector kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DetectorSchema {
    pub kind: DetectorKind,
    pub fields: Vec<DetectorFieldSchema>,
}

/// Machine-readable catalogue of every registered detector and the
/// named fields it extracts. This is the source of truth downstream
/// per-detector payload codegen (`@kasgraph/cli`) consumes; emit it
/// with the `dump-registry` binary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RegistrySchema {
    pub version: String,
    pub detectors: Vec<DetectorSchema>,
}

/// Build the [`RegistrySchema`] from the live [`registry::all`].
pub fn registry_schema() -> RegistrySchema {
    let detectors = registry::all()
        .iter()
        .map(|entry| DetectorSchema {
            kind: entry.kind,
            fields: entry
                .fingerprint
                .masked_windows
                .iter()
                .map(|w| DetectorFieldSchema {
                    name: w.field.to_owned(),
                    byte_len: w.len,
                })
                .collect(),
        })
        .collect();
    RegistrySchema {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        detectors,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detect_in_output_returns_empty_for_non_matching_script() {
        let hits = detect_in_output(&[0x00, 0x01, 0x02], "deadbeef", 0);
        assert!(hits.is_empty());
    }

    #[test]
    fn genesis_covenant_id_is_deterministic_and_64_hex_chars() {
        let a = genesis_covenant_id("deadbeef", 0);
        let b = genesis_covenant_id("deadbeef", 0);
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn genesis_covenant_id_distinguishes_outpoint_and_index() {
        let base = genesis_covenant_id("deadbeef", 0);
        assert_ne!(base, genesis_covenant_id("deadbeef", 1));
        assert_ne!(base, genesis_covenant_id("cafebabe", 0));
    }

    #[test]
    fn genesis_covenant_id_is_domain_separated_from_plain_blake2b() {
        // The domain tag must participate, so a plain hash of the same
        // bytes (no domain) differs — guarding against collisions with
        // other blake2b uses in the workspace (e.g. POI).
        let mut plain = Blake2b::<U32>::new();
        plain.update(b"deadbeef");
        plain.update(0u32.to_be_bytes());
        assert_ne!(
            genesis_covenant_id("deadbeef", 0),
            hex::encode(plain.finalize())
        );
    }

    #[test]
    fn detect_in_output_returns_hit_for_known_pattern() {
        // Use the OpenSilverOwnable canonical bytes from the registry;
        // splice an arbitrary owner pubkey into the masked window so
        // matching still succeeds.
        let entry = registry::all()
            .iter()
            .find(|e| e.kind == DetectorKind::OpenSilverOwnable)
            .expect("OpenSilverOwnable registered");
        let mut script = entry.fingerprint.bytes.clone();
        for w in &entry.fingerprint.masked_windows {
            for i in 0..w.len {
                script[w.offset + i] = 0xAB;
            }
        }
        let hits = detect_in_output(&script, "abc123", 7);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, DetectorKind::OpenSilverOwnable);
        assert_eq!(hits[0].tx_hash, "abc123");
        assert_eq!(hits[0].output_index, 7);
        // Payload contains the masked field as hex.
        let payload = hits[0].payload.as_object().expect("payload is object");
        assert!(!payload.is_empty());
    }

    #[test]
    fn unrelated_script_with_correct_length_does_not_match() {
        let entry = registry::all()
            .iter()
            .find(|e| e.kind == DetectorKind::OpenSilverOwnable)
            .unwrap();
        let script = vec![0xFFu8; entry.fingerprint.bytes.len()];
        let hits = detect_in_output(&script, "tx", 0);
        // Could match if every fixed byte coincidentally is 0xFF; the
        // canonical bytes start with 0x01, so this collides only if
        // the registry was changed. Asserting no Ownable hit catches
        // accidental over-matching.
        assert!(hits
            .iter()
            .all(|h| h.kind != DetectorKind::OpenSilverOwnable));
    }

    #[test]
    fn registry_schema_covers_every_registered_detector() {
        let schema = registry_schema();
        assert_eq!(schema.detectors.len(), registry::all().len());
        assert!(!schema.detectors.is_empty());
        assert_eq!(schema.version, env!("CARGO_PKG_VERSION"));
        for d in &schema.detectors {
            assert!(!d.fields.is_empty(), "{:?} has no fields", d.kind);
            for f in &d.fields {
                assert!(!f.name.is_empty(), "{:?} has an unnamed field", d.kind);
                assert!(f.byte_len > 0, "{:?}/{} has zero width", d.kind, f.name);
            }
        }
    }

    #[test]
    fn registry_schema_fields_match_masked_windows() {
        let schema = registry_schema();
        let multisig = schema
            .detectors
            .iter()
            .find(|d| d.kind == DetectorKind::OpenSilverMultisig)
            .expect("multisig in schema");
        assert_eq!(
            multisig.fields,
            vec![
                DetectorFieldSchema {
                    name: "signer_pubkeys".to_owned(),
                    byte_len: 96
                },
                DetectorFieldSchema {
                    name: "threshold".to_owned(),
                    byte_len: 1
                },
            ],
        );
    }

    #[test]
    fn registry_schema_round_trips_through_json() {
        let schema = registry_schema();
        let json = serde_json::to_string(&schema).unwrap();
        let back: RegistrySchema = serde_json::from_str(&json).unwrap();
        assert_eq!(back, schema);
    }
}
