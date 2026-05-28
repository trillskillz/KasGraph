// Native KRC-721 mapping handlers (AssemblyScript).
//
// See examples/kasbonds/src/mapping.ts for the runtime/ABI contract these
// handlers are written against. This data source watches no registered
// detector pattern, so payload fields are read by their freeform names.

import {
  decodeEvent,
  store,
  objStr,
  objU64,
  objBool,
  JSON,
} from "@kasgraph/as-mapping/assembly";

// Fires when a collection covenant first appears on-chain.
export function handleCollectionDeployed(ptr: i32, len: i32): void {
  const ev = decodeEvent(ptr, len);
  const p = ev.payload;
  const id = objStr(p, "collectionCovenantId");

  const c = new JSON.Obj();
  c.set<string>("collectionCovenantId", id);
  c.set<string>("name", objStr(p, "name"));
  c.set<string>("maxSupply", objStr(p, "maxSupply"));
  c.set<i64>("mintedSupply", 0);
  c.set<i64>("burnedSupply", 0);
  c.set<i64>("holderCount", 0);
  c.set<i64>("deployedAtDaa", <i64>ev.daaScore);
  store.set("KRC721Collection", id, c);
}

// Fires on the genesis (mint) of a per-NFT covenant. Creates the Token and
// bumps the collection's minted supply.
export function handleNftMinted(ptr: i32, len: i32): void {
  const ev = decodeEvent(ptr, len);
  const p = ev.payload;
  const colId = objStr(p, "collectionCovenantId");
  const col = store.get("KRC721Collection", colId);
  if (col == null) return;

  const tokenId = objStr(p, "tokenCovenantId");
  const t = new JSON.Obj();
  t.set<string>("collection", colId);
  t.set<string>("tokenCovenantId", tokenId);
  t.set<string>("tokenId", objStr(p, "tokenId"));
  t.set<string>("metadataUri", objStr(p, "metadataUri"));
  t.set<i64>("mintedAtDaa", <i64>ev.daaScore);
  t.set<bool>("burned", false);
  t.set<i64>("transferCount", 0);
  store.set("KRC721Token", tokenId, t);

  const minted = objU64(col, "mintedSupply") + 1;
  const updated = new JSON.Obj();
  updated.set<string>("collectionCovenantId", colId);
  updated.set<i64>("mintedSupply", <i64>minted);
  store.set("KRC721Collection", colId, updated);
}

// Fires on a per-NFT lineage transition that changes ownership. Reassigns
// the token owner, bumps its transfer count, and emits a Transfer row.
export function handleNftTransferred(ptr: i32, len: i32): void {
  const ev = decodeEvent(ptr, len);
  const p = ev.payload;
  const tokenId = objStr(p, "tokenCovenantId");
  const t = store.get("KRC721Token", tokenId);
  if (t == null || objBool(t, "burned")) return;

  const to = objStr(p, "toPubkey");
  const transferCount = objU64(t, "transferCount") + 1;

  const updated = new JSON.Obj();
  updated.set<string>("tokenCovenantId", tokenId);
  updated.set<string>("collection", objStr(t, "collection"));
  updated.set<string>("owner", to);
  updated.set<bool>("burned", false);
  updated.set<i64>("transferCount", <i64>transferCount);
  store.set("KRC721Token", tokenId, updated);

  const xfer = new JSON.Obj();
  xfer.set<string>("token", tokenId);
  xfer.set<string>("to", to);
  xfer.set<i64>("atDaa", <i64>ev.daaScore);
  store.set("KRC721Transfer", tokenId + "-" + ev.blockHash, xfer);
}

// Fires when a per-NFT covenant is spent into a burn sink. Marks the token
// burned and bumps the collection's burned supply.
export function handleNftBurned(ptr: i32, len: i32): void {
  const ev = decodeEvent(ptr, len);
  const p = ev.payload;
  const tokenId = objStr(p, "tokenCovenantId");
  const t = store.get("KRC721Token", tokenId);
  if (t == null || objBool(t, "burned")) return;

  const updated = new JSON.Obj();
  updated.set<string>("tokenCovenantId", tokenId);
  updated.set<string>("collection", objStr(t, "collection"));
  updated.set<bool>("burned", true);
  store.set("KRC721Token", tokenId, updated);

  const colId = objStr(t, "collection");
  const col = store.get("KRC721Collection", colId);
  if (col == null) return;
  const burned = objU64(col, "burnedSupply") + 1;
  const cu = new JSON.Obj();
  cu.set<string>("collectionCovenantId", colId);
  cu.set<i64>("burnedSupply", <i64>burned);
  store.set("KRC721Collection", colId, cu);
}
