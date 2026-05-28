// Native KRC-20 (KCC20) mapping handlers.

import type { CovenantLockedEvent, CovenantSpentEvent } from './generated/events.js';

/**
 * Fires on the first appearance of every KCC20 covenant — both
 * asset contracts and any of the four controller variants.
 */
export async function handleAssetOrControllerDeployed(
  event: CovenantLockedEvent,
): Promise<void> {
  void event;
  // Pseudo-code:
  //   const kind = event.payload.detectorKind;
  //   if (kind === 'KCC20Asset') {
  //     const a = new KCC20Asset(event.payload.assetCovenantId);
  //     a.assetCovenantId      = event.payload.assetCovenantId;
  //     a.controllerCovenantId = event.payload.controllerCovenantId;
  //     a.decimals             = event.payload.decimals;
  //     a.totalSupply          = event.payload.totalSupply;
  //     a.mintNonce            = event.payload.mintNonce;
  //     a.deployedAtDaa        = event.block.daaScore;
  //     a.holderCount          = 0;
  //     await a.save();
  //   } else {
  //     // KCC20{Ownable|Pausable|Capped|Vesting}Controller
  //     const c = new KCC20Controller(event.payload.controllerCovenantId);
  //     c.controllerCovenantId = event.payload.controllerCovenantId;
  //     c.assetCovenantId      = event.payload.assetCovenantId;
  //     c.controllerKind       = kind;
  //     c.ownerPubkey          = event.payload.ownerPubkey ?? null;
  //     c.pausedFlag           = event.payload.pausedFlag ?? null;
  //     c.remainingAllowance   = event.payload.remainingAllowance ?? null;
  //     c.scheduleRoot         = event.payload.scheduleRoot ?? null;
  //     c.active               = true;
  //     await c.save();
  //   }
}

/**
 * Fires on every spend of a KCC20 covenant. Distinguishes:
 *   - Transfer: holder balance delta + Transfer entity
 *   - Mint    : asset.totalSupply delta + Mint entity
 *   - Burn    : asset.totalSupply delta, no Transfer
 *   - Controller rotation: KCC20Asset.controllerCovenantId update
 */
export async function handleAssetTransition(event: CovenantSpentEvent): Promise<void> {
  void event;
  // Pseudo-code:
  //   const asset = await KCC20Asset.load(event.payload.assetCovenantId);
  //   if (asset === null) return;
  //
  //   switch (event.payload.operation) {
  //     case 'transfer': {
  //       // Update from/to holders + emit a KCC20Transfer.
  //       break;
  //     }
  //     case 'mint': {
  //       asset.totalSupply += event.payload.amount;
  //       await asset.save();
  //       // Emit a KCC20Mint linking the controller.
  //       break;
  //     }
  //     case 'burn': {
  //       asset.totalSupply -= event.payload.amount;
  //       await asset.save();
  //       // Update sender's holder row.
  //       break;
  //     }
  //     case 'rotate_controller': {
  //       asset.controllerCovenantId = event.payload.newControllerCovenantId;
  //       await asset.save();
  //       break;
  //     }
  //   }
}
