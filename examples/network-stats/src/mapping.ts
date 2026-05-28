// Network-stats mapping handlers (AssemblyScript).
//
// See examples/kasbonds/src/mapping.ts for the runtime/ABI contract these
// handlers are written against. This data source watches no registered
// detector pattern, so payload fields are read by their freeform names.

import {
  decodeEvent,
  store,
  objStr,
  objU64,
  JSON,
} from "@kasgraph/as-mapping/assembly";

// Fires once per accepted block. Records the per-block stat row and folds
// its counts into the rolling DailyStat for the block's UTC day.
export function handleBlockAdded(ptr: i32, len: i32): void {
  const ev = decodeEvent(ptr, len);
  const p = ev.payload;

  const b = new JSON.Obj();
  b.set<string>("blockHash", ev.blockHash);
  b.set<i64>("daaScore", <i64>ev.daaScore);
  b.set<i64>("timestamp", <i64>objU64(p, "timestamp"));
  b.set<i64>("txCount", <i64>objU64(p, "txCount"));
  b.set<string>("totalFees", objStr(p, "totalFees"));
  b.set<string>("totalOutputAmount", objStr(p, "totalOutputAmount"));
  store.set("BlockStat", ev.blockHash, b);

  const day = objStr(p, "day");
  const prior = store.get("DailyStat", day);
  const blockCount = (prior != null ? objU64(prior, "blockCount") : 0) + 1;
  const txTotal =
    (prior != null ? objU64(prior, "txCount") : 0) + objU64(p, "txCount");

  const d = new JSON.Obj();
  d.set<string>("day", day);
  d.set<i64>("blockCount", <i64>blockCount);
  d.set<i64>("txCount", <i64>txTotal);
  store.set("DailyStat", day, d);
}

// Fires on every UTXO create/spend in the firehose. Maintains per-address
// lifetime counters: tx count and the live UTXO balance.
export function handleUtxoChanged(ptr: i32, len: i32): void {
  const ev = decodeEvent(ptr, len);
  const p = ev.payload;
  const addr = objStr(p, "address");
  const prior = store.get("AddressActivity", addr);

  const txCount = (prior != null ? objU64(prior, "txCount") : 0) + 1;
  let utxoCount: i64 = prior != null ? <i64>objU64(prior, "utxoCount") : 0;
  if (objStr(p, "kind") == "created") {
    utxoCount += 1;
  } else {
    utxoCount -= 1;
  }

  const a = new JSON.Obj();
  a.set<string>("address", addr);
  a.set<i64>("txCount", <i64>txCount);
  a.set<i64>("utxoCount", utxoCount);
  a.set<i64>("lastSeenAtDaa", <i64>ev.daaScore);
  store.set("AddressActivity", addr, a);
}
