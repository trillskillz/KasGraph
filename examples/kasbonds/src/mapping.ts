// KasBonds mapping handlers.
//
// `kasgraph codegen` regenerates ./generated/{entities,events}.ts
// from schema.graphql + subgraph.yaml. Handlers below import
// from those generated files.
//
// The named exports must match the `handler:` keys in
// subgraph.yaml — the mapping runtime resolves them by name when
// it dispatches a typed event.

import type { CovenantLockedEvent, CovenantSpentEvent } from './generated/events.js';

/**
 * Fires the first time a covenant matching `OpenSilverVault` or
 * `OpenSilverEscrowMilestone` enters the chain. Creates the Bond
 * entity + the initial Holding row.
 */
export async function handleBondIssued(event: CovenantLockedEvent): Promise<void> {
  // TODO: pull issuer + face value + coupon from the detector
  // payload once per-detector payload codegen lands. For now
  // payload is typed as `unknown` — cast inside the handler.
  void event;
  // Pseudo-code:
  //   const bond = new Bond(event.payload.covenantId);
  //   bond.covenantId      = event.payload.covenantId;
  //   bond.issuer          = event.payload.issuer;
  //   bond.faceValueSompi  = event.payload.faceValue;
  //   bond.couponBps       = event.payload.couponBps;
  //   bond.issuedAtDaa     = event.block.daaScore;
  //   bond.redeemed        = false;
  //   bond.currentHolder   = event.payload.issuer;
  //   await bond.save();
  //
  //   const holding = new Holding(`${bond.id}-${event.payload.issuer}`);
  //   holding.bond          = bond.id;
  //   holding.holder        = event.payload.issuer;
  //   holding.acquiredAtDaa = event.block.daaScore;
  //   holding.amountSompi   = bond.faceValueSompi;
  //   await holding.save();
}

/**
 * Fires on every spend of a covenant in the bond's lineage.
 * Distinguishes coupon payouts (the bond covenant id persists)
 * from redemption (a final spend with no successor covenant
 * output) by inspecting the manifest detector's typed payload.
 */
export async function handleBondTransition(event: CovenantSpentEvent): Promise<void> {
  void event;
  // Pseudo-code:
  //   const bond = await Bond.load(event.payload.covenantId);
  //   if (bond === null) return;            // not one of ours
  //   if (event.payload.successorCovenantId !== null) {
  //     // Coupon payout: amount comes from the inputs/outputs
  //     // delta on the spend tx.
  //     const coupon = new Coupon(`${bond.id}-${event.tx.hash}`);
  //     coupon.bond        = bond.id;
  //     coupon.paidAtDaa   = event.block.daaScore;
  //     coupon.amountSompi = event.payload.couponAmount;
  //     coupon.payer       = event.payload.signer;
  //     coupon.recipient   = event.payload.recipient;
  //     coupon.txHash      = event.tx.hash;
  //     await coupon.save();
  //   } else {
  //     // Final redemption.
  //     bond.redeemed      = true;
  //     bond.currentHolder = null;
  //     await bond.save();
  //
  //     const lastHolding = await Holding.loadActive(bond.id);
  //     if (lastHolding !== null) {
  //       lastHolding.releasedAtDaa = event.block.daaScore;
  //       await lastHolding.save();
  //     }
  //   }
}
