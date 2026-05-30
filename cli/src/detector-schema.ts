// Detector field schema — mirrors crates/kasgraph-detectors registry.
//
// DO NOT EDIT BY HAND. Regenerate with:
//   cargo run -p kasgraph-detectors --bin dump-registry \
//     | node cli/scripts/gen-detector-schema.mjs > cli/src/detector-schema.ts
//
// Every detector state field is hex-encoded at runtime, so each maps
// to a `string` in generated payload types.

export interface DetectorFieldSchema {
  readonly name: string;
  readonly byteLen: number;
}

export interface DetectorSchema {
  readonly kind: string;
  readonly fields: readonly DetectorFieldSchema[];
}

export const DETECTOR_SCHEMA_VERSION = "0.1.0";

export const DETECTOR_SCHEMA: readonly DetectorSchema[] = [
  {
    kind: "OpenSilverOwnable",
    fields: [
      { name: "owner_pubkey", byteLen: 32 },
      { name: "has_pending", byteLen: 1 },
      { name: "pending_owner_pubkey", byteLen: 32 },
    ],
  },
  {
    kind: "OpenSilverMultisig",
    fields: [
      { name: "threshold", byteLen: 8 },
      { name: "signer_pubkey_1", byteLen: 32 },
      { name: "signer_pubkey_2", byteLen: 32 },
      { name: "signer_pubkey_3", byteLen: 32 },
    ],
  },
  {
    kind: "OpenSilverTimeLock",
    fields: [
      { name: "owner_pubkey", byteLen: 32 },
      { name: "beneficiary_pubkey", byteLen: 32 },
      { name: "unlock_time", byteLen: 8 },
      { name: "soft_cancel", byteLen: 1 },
    ],
  },
  {
    kind: "OpenSilverVault",
    fields: [
      { name: "owner_pubkey", byteLen: 32 },
      { name: "has_pending", byteLen: 1 },
      { name: "pending_owner_pubkey", byteLen: 32 },
      { name: "threshold", byteLen: 8 },
      { name: "signer_pubkey_1", byteLen: 32 },
      { name: "signer_pubkey_2", byteLen: 32 },
      { name: "signer_pubkey_3", byteLen: 32 },
      { name: "unlock_time", byteLen: 8 },
      { name: "beneficiary_pubkey", byteLen: 32 },
    ],
  },
  {
    kind: "OpenSilverEscrowBilateral",
    fields: [
      { name: "buyer_pubkey", byteLen: 32 },
      { name: "seller_pubkey", byteLen: 32 },
      { name: "arbiter_hash", byteLen: 32 },
      { name: "timeout", byteLen: 8 },
    ],
  },
  {
    kind: "OpenSilverEscrowMilestone",
    fields: [
      { name: "buyer_pubkey", byteLen: 32 },
      { name: "seller_pubkey", byteLen: 32 },
      { name: "arbiter_hash", byteLen: 32 },
      { name: "total_milestones", byteLen: 8 },
      { name: "completed_milestones", byteLen: 8 },
      { name: "timeout", byteLen: 8 },
    ],
  },
  {
    kind: "OpenSilverStreamingPayment",
    fields: [
      { name: "sender_pubkey", byteLen: 32 },
      { name: "recipient_pubkey", byteLen: 32 },
      { name: "rate_per_claim", byteLen: 8 },
      { name: "total_allowance", byteLen: 8 },
      { name: "remaining_allowance", byteLen: 8 },
      { name: "period", byteLen: 8 },
      { name: "next_release_time", byteLen: 8 },
    ],
  },
  {
    kind: "OpenSilverVesting",
    fields: [
      { name: "beneficiary_pubkey", byteLen: 32 },
      { name: "admin_pubkey", byteLen: 32 },
      { name: "total_allocation", byteLen: 8 },
      { name: "claimed_amount", byteLen: 8 },
      { name: "cliff_time", byteLen: 8 },
      { name: "period", byteLen: 8 },
      { name: "release_per_period", byteLen: 8 },
      { name: "revocable", byteLen: 1 },
    ],
  },
  {
    kind: "OpenSilverDeadMansSwitch",
    fields: [
      { name: "owner_pubkey", byteLen: 32 },
      { name: "fallback_pubkey", byteLen: 32 },
      { name: "timeout_age", byteLen: 8 },
      { name: "last_ping_age", byteLen: 8 },
    ],
  },
  {
    kind: "OpenSilverSocialRecovery",
    fields: [
      { name: "owner_pubkey", byteLen: 32 },
      { name: "has_pending_owner", byteLen: 1 },
      { name: "pending_owner_pubkey", byteLen: 32 },
      { name: "guardian_threshold", byteLen: 8 },
      { name: "guardian_pubkey_1", byteLen: 32 },
      { name: "guardian_pubkey_2", byteLen: 32 },
      { name: "guardian_pubkey_3", byteLen: 32 },
      { name: "activation_time", byteLen: 8 },
      { name: "recovery_delay", byteLen: 8 },
    ],
  },
  {
    kind: "OpenSilverAtomicSwapHTLC",
    fields: [
      { name: "recipient_pubkey", byteLen: 32 },
      { name: "refunder_pubkey", byteLen: 32 },
      { name: "secret_hash", byteLen: 32 },
      { name: "timeout", byteLen: 8 },
    ],
  },
  {
    kind: "OpenSilverFreelancePayroll",
    fields: [
      { name: "client_pubkey", byteLen: 32 },
      { name: "worker_pubkey", byteLen: 32 },
      { name: "arbiter_hash", byteLen: 32 },
      { name: "timeout", byteLen: 8 },
    ],
  },
  {
    kind: "KCC20Asset",
    fields: [
      { name: "owner_identifier", byteLen: 32 },
      { name: "identifier_type", byteLen: 1 },
      { name: "amount", byteLen: 8 },
      { name: "is_minter", byteLen: 1 },
    ],
  },
  {
    kind: "KCC20OwnableController",
    fields: [
      { name: "admin_pubkey", byteLen: 32 },
      { name: "has_pending_admin", byteLen: 1 },
      { name: "pending_admin_pubkey", byteLen: 32 },
      { name: "kcc20_covenant_id", byteLen: 32 },
      { name: "initialized", byteLen: 1 },
    ],
  },
  {
    kind: "KCC20PausableController",
    fields: [
      { name: "kcc20_covenant_id", byteLen: 32 },
      { name: "paused", byteLen: 1 },
      { name: "initialized", byteLen: 1 },
    ],
  },
  {
    kind: "KCC20CappedController",
    fields: [
      { name: "kcc20_covenant_id", byteLen: 32 },
      { name: "total_cap", byteLen: 8 },
      { name: "remaining_allowance", byteLen: 8 },
      { name: "initialized", byteLen: 1 },
    ],
  },
  {
    kind: "KCC20VestingController",
    fields: [
      { name: "total_allocation", byteLen: 8 },
      { name: "minted_amount", byteLen: 8 },
      { name: "cliff_time", byteLen: 8 },
      { name: "period", byteLen: 8 },
      { name: "release_per_period", byteLen: 8 },
      { name: "kcc20_covenant_id", byteLen: 32 },
      { name: "initialized", byteLen: 1 },
    ],
  },
];

export const DETECTOR_SCHEMA_BY_KIND: ReadonlyMap<string, DetectorSchema> =
  new Map(DETECTOR_SCHEMA.map((d) => [d.kind, d]));

