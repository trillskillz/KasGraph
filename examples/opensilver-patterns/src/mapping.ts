// OpenSilver patterns mapping handlers.

import type { CovenantLockedEvent, CovenantSpentEvent } from './generated/events.js';

/**
 * Fires on the first appearance of any OpenSilver pattern UTXO.
 * Records the generic PatternInstance + dispatches to the
 * kind-specific entity (Vault, Multisig, Escrow, …) when one
 * exists.
 */
export async function handlePatternEntry(event: CovenantLockedEvent): Promise<void> {
  void event;
  // Pseudo-code:
  //   const instance = new PatternInstance(event.payload.covenantId);
  //   instance.covenantId      = event.payload.covenantId;
  //   instance.patternKind     = event.payload.detectorKind;
  //   instance.firstSeenAtDaa  = event.block.daaScore;
  //   instance.lastSeenAtDaa   = event.block.daaScore;
  //   instance.transitionCount = 0;
  //   instance.active          = true;
  //   await instance.save();
  //
  //   switch (event.payload.detectorKind) {
  //     case 'OpenSilverVault': {
  //       const v = new VaultInstance(instance.id);
  //       v.covenantId           = instance.covenantId;
  //       v.ownerPubkey          = event.payload.ownerPubkey;
  //       v.recoveryPubkey       = event.payload.recoveryPubkey;
  //       v.recoveryDelayBlocks  = event.payload.recoveryDelayBlocks;
  //       v.drained              = false;
  //       await v.save();
  //       break;
  //     }
  //     case 'OpenSilverMultisig': {
  //       const m = new MultisigInstance(instance.id);
  //       m.covenantId  = instance.covenantId;
  //       m.signerCount = event.payload.signerPubkeys.length / 32;
  //       m.threshold   = event.payload.threshold;
  //       m.active      = true;
  //       await m.save();
  //       break;
  //     }
  //     case 'OpenSilverEscrowBilateral':
  //     case 'OpenSilverEscrowMilestone': {
  //       const e = new EscrowInstance(instance.id);
  //       e.covenantId     = instance.covenantId;
  //       e.buyer          = event.payload.buyerPubkey;
  //       e.seller         = event.payload.sellerPubkey;
  //       e.arbiter        = event.payload.arbiterPubkey ?? null;
  //       e.milestoneCount = event.payload.milestoneCount ?? null;
  //       e.released       = false;
  //       await e.save();
  //       break;
  //     }
  //     // …
  //   }
}

/**
 * Fires on every spend of an indexed pattern UTXO. Records the
 * transition + flips `active=false` on the specialised entity
 * when the spend has no successor covenant output (terminal
 * spend).
 */
export async function handlePatternTransition(event: CovenantSpentEvent): Promise<void> {
  void event;
  // Pseudo-code:
  //   const instance = await PatternInstance.load(event.payload.covenantId);
  //   if (instance === null) return;
  //
  //   const t = new PatternTransition(`${instance.id}-${event.tx.hash}-${event.payload.outputIndex}`);
  //   t.instance    = instance.id;
  //   t.daaScore    = event.block.daaScore;
  //   t.txHash      = event.tx.hash;
  //   t.outputIndex = event.payload.outputIndex;
  //   t.payload     = event.payload;
  //   await t.save();
  //
  //   instance.lastSeenAtDaa   = event.block.daaScore;
  //   instance.transitionCount += 1;
  //   instance.active          = event.payload.successorCovenantId !== null;
  //   await instance.save();
}
