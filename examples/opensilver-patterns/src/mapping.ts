// OpenSilver patterns mapping handlers (AssemblyScript).
//
// See examples/kasbonds/src/mapping.ts for the runtime/ABI contract these
// handlers are written against.

import {
  decodeEvent,
  store,
  objStr,
  objU64,
  JSON,
} from "@kasgraph/as-mapping/assembly";

// Fires on the first appearance of any OpenSilver pattern UTXO. Records the
// generic PatternInstance and dispatches to the kind-specific entity when one
// exists (Vault, Multisig, Escrow).
export function handlePatternEntry(ptr: i32, len: i32): void {
  const ev = decodeEvent(ptr, len);
  const p = ev.payload;
  const id = ev.blockHash;
  const kind = objStr(p, "detectorKind");

  const instance = new JSON.Obj();
  instance.set<string>("covenantId", id);
  instance.set<string>("patternKind", kind);
  instance.set<i64>("firstSeenAtDaa", <i64>ev.daaScore);
  instance.set<i64>("lastSeenAtDaa", <i64>ev.daaScore);
  instance.set<i64>("transitionCount", 0);
  instance.set<bool>("active", true);
  store.set("PatternInstance", id, instance);

  if (kind == "OpenSilverVault") {
    const v = new JSON.Obj();
    v.set<string>("covenantId", id);
    v.set<string>("ownerPubkey", objStr(p, "owner_pubkey"));
    v.set<string>("recoveryPubkey", objStr(p, "recovery_pubkey"));
    v.set<string>("recoveryDelayBlocks", objStr(p, "recovery_delay_blocks"));
    v.set<bool>("drained", false);
    store.set("VaultInstance", id, v);
  } else if (kind == "OpenSilverMultisig") {
    const m = new JSON.Obj();
    m.set<string>("covenantId", id);
    m.set<string>("threshold", objStr(p, "threshold"));
    m.set<bool>("active", true);
    store.set("MultisigInstance", id, m);
  } else if (
    kind == "OpenSilverEscrowBilateral" ||
    kind == "OpenSilverEscrowMilestone"
  ) {
    const e = new JSON.Obj();
    e.set<string>("covenantId", id);
    e.set<string>("buyer", objStr(p, "buyer_pubkey"));
    e.set<string>("seller", objStr(p, "seller_pubkey"));
    e.set<string>("milestoneCount", objStr(p, "milestone_count"));
    e.set<bool>("released", false);
    store.set("EscrowInstance", id, e);
  }
}

// Fires on every spend of an indexed pattern UTXO. Records the transition and
// flips `active` off when the spend is terminal (no successor covenant).
export function handlePatternTransition(ptr: i32, len: i32): void {
  const ev = decodeEvent(ptr, len);
  const p = ev.payload;
  const spend = p != null ? p.getObj("spend") : null;
  const id = ev.blockHash;

  const instance = store.get("PatternInstance", id);
  if (instance == null) return;

  const successor = objStr(spend, "successorCovenantId");

  const t = new JSON.Obj();
  t.set<string>("instance", id);
  t.set<i64>("daaScore", <i64>ev.daaScore);
  t.set<string>("operation", objStr(spend, "operation"));
  store.set("PatternTransition", id + "-" + successor, t);

  const transitionCount = objU64(instance, "transitionCount") + 1;
  const updated = new JSON.Obj();
  updated.set<string>("covenantId", id);
  updated.set<string>("patternKind", objStr(instance, "patternKind"));
  updated.set<i64>("firstSeenAtDaa", <i64>objU64(instance, "firstSeenAtDaa"));
  updated.set<i64>("lastSeenAtDaa", <i64>ev.daaScore);
  updated.set<i64>("transitionCount", <i64>transitionCount);
  updated.set<bool>("active", successor.length > 0);
  store.set("PatternInstance", id, updated);
}
