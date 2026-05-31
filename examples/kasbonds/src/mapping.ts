// KasBonds mapping handlers (AssemblyScript).
//
// Compiled to WASM by `kasgraph build` and dispatched by the
// `kasgraph-mapping` runtime. The runtime hands each handler a (ptr, len)
// into a UTF-8 JSON event document `{ block: { daaScore, hash }, payload }`;
// `decodeEvent` turns it into a typed `Event`. Handlers read payload fields
// via the `obj*` accessors and persist entities through `store.set` /
// `store.get`.
//
// The exported names must match the `handler:` keys in subgraph.yaml — the
// runtime resolves them by name. The build glue re-exports each one under
// the (ptr, len) ABI signature.

import {
  decodeEvent,
  store,
  log,
  LOG_INFO,
  objStr,
  objU64,
  JSON,
} from "@kasgraph/as-mapping/assembly";

// Fires the first time a covenant matching `OpenSilverVault` or
// `OpenSilverEscrowMilestone` enters the chain. Creates the Bond entity plus
// the initial Holding row. The bond is keyed by the stable KIP-20 covenant id
// so later spends in different blocks can load the same Bond.
export function handleBondIssued(ptr: i32, len: i32): void {
  const ev = decodeEvent(ptr, len);
  const p = ev.payload;
  const id = bondIdFromLockedPayload(p, ev.blockHash);
  const issuer = objStr(p, "owner_pubkey");

  const bond = new JSON.Obj();
  bond.set<string>("covenantId", id);
  bond.set<string>("issuer", issuer);
  bond.set<string>("patternKind", objStr(p, "detectorKind"));
  bond.set<i64>("issuedAtDaa", <i64>ev.daaScore);
  bond.set<bool>("redeemed", false);
  bond.set<string>("currentHolder", issuer);
  store.set("Bond", id, bond);

  const holding = new JSON.Obj();
  holding.set<string>("bond", id);
  holding.set<string>("holder", issuer);
  holding.set<i64>("acquiredAtDaa", <i64>ev.daaScore);
  holding.set<string>("amountSompi", "0");
  store.set("Holding", id + "-" + issuer, holding);

  log(LOG_INFO, "kasbonds: issued bond " + id);
}

// Fires on every spend of a covenant in the bond's lineage. A spend with a
// successor covenant output is a coupon payout; a terminal spend (no
// successor) is the final redemption.
export function handleBondTransition(ptr: i32, len: i32): void {
  const ev = decodeEvent(ptr, len);
  const p = ev.payload;
  const spend = p != null ? p.getObj("spend") : null;

  const bondId = bondIdFromSpend(spend, ev.blockHash);
  const bond = store.get("Bond", bondId);
  if (bond == null) return; // not one of ours

  const successor = objStr(spend, "successorCovenantId");
  if (successor.length > 0) {
    // Coupon payout: amount is the consumed covenant value on the spend.
    const coupon = new JSON.Obj();
    coupon.set<string>("bond", bondId);
    coupon.set<i64>("paidAtDaa", <i64>ev.daaScore);
    coupon.set<string>("amountSompi", objStr(spend, "spentValueSompi"));
    store.set("Coupon", bondId + "-" + successor, coupon);
  } else {
    // Final redemption.
    const redeemed = new JSON.Obj();
    redeemed.set<string>("covenantId", bondId);
    redeemed.set<string>("issuer", objStr(bond, "issuer"));
    redeemed.set<i64>("issuedAtDaa", <i64>objU64(bond, "issuedAtDaa"));
    redeemed.set<bool>("redeemed", true);
    store.set("Bond", bondId, redeemed);
  }
}

function bondIdFromLockedPayload(payload: JSON.Obj | null, blockHash: string): string {
  const covenantId = objStr(payload, "covenantId");
  if (covenantId.length > 0) return covenantId;
  // Fallback for legacy fixtures emitted before KasGraph copied covenantId
  // into lock payloads. Real lineage mappings must not rely on block hashes:
  // each transition can occur in a different block.
  return blockHash;
}

function bondIdFromSpend(spend: JSON.Obj | null, blockHash: string): string {
  const covenantId = objStr(spend, "covenantId");
  if (covenantId.length > 0) return covenantId;
  // Same legacy fallback as lock events; only used when older event payloads
  // omit covenantId, in which case cross-block lineage lookup is impossible.
  return blockHash;
}
