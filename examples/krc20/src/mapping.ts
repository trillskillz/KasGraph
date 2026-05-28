// Native KRC-20 (KCC20) mapping handlers (AssemblyScript).
//
// See examples/kasbonds/src/mapping.ts for the runtime/ABI contract these
// handlers are written against.

import {
  decodeEvent,
  store,
  objStr,
  JSON,
} from "@kasgraph/as-mapping/assembly";

// Fires on the first appearance of every KCC20 covenant — both asset
// contracts and any of the four controller variants. Branches on the
// detector kind to write either a KCC20Asset or a KCC20Controller.
export function handleAssetOrControllerDeployed(ptr: i32, len: i32): void {
  const ev = decodeEvent(ptr, len);
  const p = ev.payload;
  const kind = objStr(p, "detectorKind");
  const id = ev.blockHash;

  if (kind == "KCC20Asset") {
    const a = new JSON.Obj();
    a.set<string>("assetCovenantId", id);
    a.set<string>("controllerCovenantId", objStr(p, "controller_covenant_id"));
    a.set<string>("decimals", objStr(p, "decimals"));
    a.set<string>("totalSupply", objStr(p, "total_supply"));
    a.set<string>("mintNonce", objStr(p, "mint_nonce"));
    a.set<i64>("deployedAtDaa", <i64>ev.daaScore);
    a.set<i64>("holderCount", 0);
    store.set("KCC20Asset", id, a);
  } else {
    const c = new JSON.Obj();
    c.set<string>("controllerCovenantId", id);
    c.set<string>("assetCovenantId", objStr(p, "asset_covenant_id"));
    c.set<string>("controllerKind", kind);
    c.set<string>("ownerPubkey", objStr(p, "owner_pubkey"));
    c.set<bool>("active", true);
    store.set("KCC20Controller", id, c);
  }
}

// Fires on every spend of a KCC20 covenant. The protocol-level operation on
// the spend envelope selects the effect: transfer, mint, burn, or controller
// rotation.
export function handleAssetTransition(ptr: i32, len: i32): void {
  const ev = decodeEvent(ptr, len);
  const p = ev.payload;
  const spend = p != null ? p.getObj("spend") : null;

  const assetId = ev.blockHash;
  const asset = store.get("KCC20Asset", assetId);
  if (asset == null) return; // spend of a covenant we don't track as an asset

  const operation = objStr(spend, "operation");
  const valueSompi = objStr(spend, "spentValueSompi");

  if (operation == "transfer") {
    const t = new JSON.Obj();
    t.set<string>("asset", assetId);
    t.set<string>("amountSompi", valueSompi);
    t.set<i64>("atDaa", <i64>ev.daaScore);
    store.set("KCC20Transfer", assetId + "-" + ev.blockHash, t);
  } else if (operation == "mint") {
    const m = new JSON.Obj();
    m.set<string>("asset", assetId);
    m.set<string>("amountSompi", valueSompi);
    m.set<i64>("atDaa", <i64>ev.daaScore);
    store.set("KCC20Mint", assetId + "-" + ev.blockHash, m);
  } else if (operation == "burn") {
    const updated = new JSON.Obj();
    updated.set<string>("assetCovenantId", assetId);
    updated.set<string>("lastBurnSompi", valueSompi);
    store.set("KCC20Asset", assetId, updated);
  } else if (operation == "rotate_controller") {
    const updated = new JSON.Obj();
    updated.set<string>("assetCovenantId", assetId);
    updated.set<string>(
      "controllerCovenantId",
      objStr(spend, "successorCovenantId"),
    );
    store.set("KCC20Asset", assetId, updated);
  }
}
