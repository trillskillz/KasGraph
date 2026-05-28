// ZK-proofs mapping handlers (KIP-16).

import type { CovenantLockedEvent, CovenantSpentEvent } from './generated/events.js';

/**
 * Fires when a ZK-aware covenant is locked. The lock script embeds
 * the verifying key (scheme + circuit hash + public-input arity),
 * so we register a ZkVerifyingKey keyed on the covenant id.
 */
export async function handleVerifyingKeyRegistered(
  event: CovenantLockedEvent,
): Promise<void> {
  void event;
  // Pseudo-code:
  //   const vk = new ZkVerifyingKey(event.payload.covenantId);
  //   vk.covenantId        = event.payload.covenantId;
  //   vk.scheme            = event.payload.scheme;        // e.g. "groth16-bn254"
  //   vk.circuitHash       = event.payload.circuitHash;
  //   vk.publicInputCount  = event.payload.publicInputCount;
  //   vk.registeredAtDaa   = event.block.daaScore;
  //   vk.proofCount        = 0;
  //   await vk.save();
}

/**
 * Fires on every spend of a ZK-aware covenant. The spend carries a
 * Groth16 proof + public inputs; we persist the proof, push the
 * witness blob to object storage, and record the verify outcome.
 */
export async function handleProvenSpend(event: CovenantSpentEvent): Promise<void> {
  void event;
  // Pseudo-code:
  //   const vk = await ZkVerifyingKey.load(event.payload.covenantId);
  //   if (vk === null) return;
  //
  //   const p = new ZkProof(`${event.tx.hash}:${event.tx.index}`);
  //   p.verifyingKey  = vk.id;
  //   p.covenantId    = event.payload.covenantId;
  //   p.proofBytes    = event.payload.proofBytes;
  //   p.publicInputs  = event.payload.publicInputs;
  //   p.daaScore      = event.block.daaScore;
  //   p.txHash        = event.tx.hash;
  //   await p.save();
  //
  //   // Witness blob is bulky → object storage; row holds the URI.
  //   const w = new ZkWitness(p.id);
  //   w.proof       = p.id;
  //   w.storageUri  = await putWitness(event.payload.witness);
  //   w.byteLength  = BigInt(event.payload.witness.length);
  //   w.sha256      = sha256(event.payload.witness);
  //   await w.save();
  //
  //   const v = new ZkVerification(p.id);
  //   v.proof           = p.id;
  //   v.verified        = verifyGroth16(vk, p.proofBytes, p.publicInputs);
  //   v.verifierVersion = VERIFIER_VERSION;
  //   v.verifiedAtDaa   = event.block.daaScore;
  //   await v.save();
  //
  //   vk.proofCount += 1;
  //   await vk.save();
}
