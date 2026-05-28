// Network-stats mapping handlers.

import type { BlockAddedEvent, UtxoChangedEvent } from './generated/events.js';

/**
 * Fires once per accepted block. Records block production plus the
 * per-block tx-count and fee totals, and folds them into the
 * rolling DailyStat for the block's UTC day.
 */
export async function handleBlockAdded(event: BlockAddedEvent): Promise<void> {
  void event;
  // Pseudo-code:
  //   const b = new BlockStat(event.block.hash);
  //   b.blockHash          = event.block.hash;
  //   b.daaScore           = event.block.daaScore;
  //   b.blueScore          = event.block.blueScore;
  //   b.timestamp          = event.payload.timestamp;
  //   b.txCount            = event.payload.txCount;
  //   b.totalFees          = event.payload.totalFees;
  //   b.totalOutputAmount  = event.payload.totalOutputAmount;
  //   b.parentCount        = event.payload.parentHashes.length;
  //   await b.save();
  //
  //   const day = utcDay(event.payload.timestamp);
  //   const d = (await DailyStat.load(day)) ?? freshDailyStat(day);
  //   d.blockCount += 1;
  //   d.txCount    += BigInt(b.txCount);
  //   d.totalFees  += b.totalFees;
  //   d.totalVolume += b.totalOutputAmount;
  //   // avgBlockIntervalMs updated from the prior block timestamp.
  //   await d.save();
}

/**
 * Fires on every UTXO create/spend in the firehose. Maintains
 * per-address lifetime counters (tx count, received/sent totals,
 * live UTXO count) and feeds the DailyStat active-address set.
 */
export async function handleUtxoChanged(event: UtxoChangedEvent): Promise<void> {
  void event;
  // Pseudo-code:
  //   const addr = event.payload.address;
  //   const a = (await AddressActivity.load(addr)) ?? freshActivity(addr, event);
  //   a.txCount += 1n;
  //   if (event.payload.kind === 'created') {
  //     a.totalReceived += event.payload.amount;
  //     a.utxoCount     += 1;
  //   } else { // 'spent'
  //     a.totalSent += event.payload.amount;
  //     a.utxoCount -= 1;
  //   }
  //   a.lastSeenAtDaa = event.block.daaScore;
  //   await a.save();
  //   // mark addr active in the current day's DailyStat set.
}
