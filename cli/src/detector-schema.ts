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
      { name: "signer_pubkeys", byteLen: 96 },
      { name: "threshold", byteLen: 1 },
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
      { name: "arbiter_pubkey", byteLen: 32 },
    ],
  },
  {
    kind: "OpenSilverEscrowMilestone",
    fields: [
      { name: "buyer_pubkey", byteLen: 32 },
      { name: "seller_pubkey", byteLen: 32 },
      { name: "milestone_root", byteLen: 32 },
      { name: "milestone_count", byteLen: 1 },
    ],
  },
  {
    kind: "OpenSilverStreamingPayment",
    fields: [
      { name: "sender_pubkey", byteLen: 32 },
      { name: "recipient_pubkey", byteLen: 32 },
      { name: "rate_per_block", byteLen: 8 },
      { name: "start_daa", byteLen: 8 },
    ],
  },
  {
    kind: "OpenSilverVesting",
    fields: [
      { name: "beneficiary_pubkey", byteLen: 32 },
      { name: "cliff_daa", byteLen: 8 },
      { name: "end_daa", byteLen: 8 },
      { name: "total_amount", byteLen: 8 },
    ],
  },
  {
    kind: "OpenSilverDeadMansSwitch",
    fields: [
      { name: "owner_pubkey", byteLen: 32 },
      { name: "heir_pubkey", byteLen: 32 },
      { name: "checkin_interval_blocks", byteLen: 8 },
      { name: "last_checkin_daa", byteLen: 8 },
    ],
  },
  {
    kind: "OpenSilverSocialRecovery",
    fields: [
      { name: "owner_pubkey", byteLen: 32 },
      { name: "guardian_root", byteLen: 32 },
      { name: "guardian_threshold", byteLen: 1 },
      { name: "recovery_delay_blocks", byteLen: 8 },
    ],
  },
  {
    kind: "OpenSilverAtomicSwapHTLC",
    fields: [
      { name: "alice_pubkey", byteLen: 32 },
      { name: "bob_pubkey", byteLen: 32 },
      { name: "hash_lock", byteLen: 32 },
      { name: "timeout_daa", byteLen: 8 },
    ],
  },
  {
    kind: "OpenSilverFreelancePayroll",
    fields: [
      { name: "payer_pubkey", byteLen: 32 },
      { name: "worker_root", byteLen: 32 },
      { name: "worker_count", byteLen: 1 },
      { name: "period_blocks", byteLen: 8 },
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
      { name: "owner_pubkey", byteLen: 32 },
      { name: "pending_owner_pubkey", byteLen: 32 },
      { name: "asset_covenant_id", byteLen: 32 },
    ],
  },
  {
    kind: "KCC20PausableController",
    fields: [
      { name: "owner_pubkey", byteLen: 32 },
      { name: "paused_flag", byteLen: 1 },
      { name: "asset_covenant_id", byteLen: 32 },
    ],
  },
  {
    kind: "KCC20CappedController",
    fields: [
      { name: "owner_pubkey", byteLen: 32 },
      { name: "remaining_allowance", byteLen: 16 },
      { name: "asset_covenant_id", byteLen: 32 },
    ],
  },
  {
    kind: "KCC20VestingController",
    fields: [
      { name: "owner_pubkey", byteLen: 32 },
      { name: "schedule_root", byteLen: 32 },
      { name: "schedule_count", byteLen: 1 },
      { name: "asset_covenant_id", byteLen: 32 },
    ],
  },
];

export const DETECTOR_SCHEMA_BY_KIND: ReadonlyMap<string, DetectorSchema> =
  new Map(DETECTOR_SCHEMA.map((d) => [d.kind, d]));

