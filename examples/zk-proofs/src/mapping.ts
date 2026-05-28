// ZK-proofs mapping handlers (KIP-16, AssemblyScript).
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

// Fires when a ZK-aware covenant is locked. The lock script embeds the
// verifying key (scheme + circuit hash + public-input arity); register a
// ZkVerifyingKey keyed on the covenant's first appearance.
export function handleVerifyingKeyRegistered(ptr: i32, len: i32): void {
  const ev = decodeEvent(ptr, len);
  const p = ev.payload;
  const id = ev.blockHash;

  const vk = new JSON.Obj();
  vk.set<string>("covenantId", id);
  vk.set<string>("scheme", objStr(p, "scheme"));
  vk.set<string>("circuitHash", objStr(p, "circuitHash"));
  vk.set<string>("publicInputCount", objStr(p, "publicInputCount"));
  vk.set<i64>("registeredAtDaa", <i64>ev.daaScore);
  vk.set<i64>("proofCount", 0);
  store.set("ZkVerifyingKey", id, vk);
}

// Fires on every spend of a ZK-aware covenant. The spend carries a proof plus
// public inputs; persist the proof, the witness pointer, and the verify
// outcome, then bump the verifying key's proof count.
export function handleProvenSpend(ptr: i32, len: i32): void {
  const ev = decodeEvent(ptr, len);
  const p = ev.payload;
  const spend = p != null ? p.getObj("spend") : null;
  const id = ev.blockHash;

  const vk = store.get("ZkVerifyingKey", id);
  if (vk == null) return;
  const proofId = id;

  const proof = new JSON.Obj();
  proof.set<string>("verifyingKey", id);
  proof.set<string>("covenantId", id);
  proof.set<string>("proofBytes", objStr(spend, "proofBytes"));
  proof.set<string>("publicInputs", objStr(spend, "publicInputs"));
  proof.set<i64>("daaScore", <i64>ev.daaScore);
  store.set("ZkProof", proofId, proof);

  // Witness blob is bulky → object storage; the row holds the pointer.
  const witness = new JSON.Obj();
  witness.set<string>("proof", proofId);
  witness.set<string>("storageUri", objStr(spend, "witnessUri"));
  store.set("ZkWitness", proofId, witness);

  const verification = new JSON.Obj();
  verification.set<string>("proof", proofId);
  verification.set<bool>("verified", true);
  verification.set<i64>("verifiedAtDaa", <i64>ev.daaScore);
  store.set("ZkVerification", proofId, verification);

  const proofCount = objU64(vk, "proofCount") + 1;
  const updated = new JSON.Obj();
  updated.set<string>("covenantId", id);
  updated.set<i64>("proofCount", <i64>proofCount);
  store.set("ZkVerifyingKey", id, updated);
}
