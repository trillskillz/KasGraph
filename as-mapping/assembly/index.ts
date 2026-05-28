// @kasgraph/as-mapping — AssemblyScript authoring SDK for KasGraph
// subgraph mappings.
//
// A mapping is compiled to WASM by `kasgraph build` and dispatched by the
// `kasgraph-mapping` runtime. The runtime hands each handler a pointer +
// length to a UTF-8 JSON event document; the mapping reads it, loads any
// entities it needs, and emits entity writes + log lines back through the
// host ABI. This module wraps that ABI in typed helpers so handlers don't
// touch raw pointers.
//
// Host ABI (module "kasgraph"):
//   log(level, ptr, len)                       — emit a log line
//   store_set(ptr, len)                        — write {entity,id,data}
//   store_get(ePtr,eLen,idPtr,idLen) -> i64    — read an entity by key;
//       0 on miss, else (ptr << 32) | len of the returned data JSON
//
// The runtime exports `kasgraph_alloc` + `memory` on the guest; the build
// glue supplies `kasgraph_alloc`, so a mapping never declares it.

import { JSON } from "assemblyscript-json/assembly";

export { JSON };

// ---- host imports -------------------------------------------------------

// @ts-ignore: decorator
@external("kasgraph", "log")
declare function host_log(level: i32, ptr: i32, len: i32): void;
// @ts-ignore: decorator
@external("kasgraph", "store_set")
declare function host_store_set(ptr: i32, len: i32): void;
// @ts-ignore: decorator
@external("kasgraph", "store_get")
declare function host_store_get(
  ePtr: i32,
  eLen: i32,
  idPtr: i32,
  idLen: i32,
): i64;

// ---- logging ------------------------------------------------------------

export const LOG_DEBUG: i32 = 0;
export const LOG_INFO: i32 = 1;
export const LOG_WARN: i32 = 2;
export const LOG_ERROR: i32 = 3;

export function log(level: i32, message: string): void {
  const buf = String.UTF8.encode(message);
  host_log(level, changetype<i32>(buf), buf.byteLength);
}

// ---- event decode -------------------------------------------------------

/**
 * A decoded mapping event. `payload` is the detector / spend payload the
 * codegen'd event type describes; handlers read its fields via the JSON
 * accessors (`payload.getString("...")`, etc.). It is `null` when the
 * event carries no object payload.
 */
export class Event {
  daaScore: u64 = 0;
  blockHash: string = "";
  payload: JSON.Obj | null = null;

  /** Convenience: read a string field off the payload, or "" if absent. */
  payloadStr(key: string): string {
    const p = this.payload;
    if (p == null) return "";
    const v = p.getString(key);
    return v != null ? v.valueOf() : "";
  }
}

/** Decode the JSON event the host wrote at `ptr..ptr+len`. */
export function decodeEvent(ptr: i32, len: i32): Event {
  const root = <JSON.Obj>JSON.parse(String.UTF8.decodeUnsafe(ptr, len));
  const ev = new Event();
  const block = root.getObj("block");
  if (block != null) {
    const daa = block.getInteger("daaScore");
    if (daa != null) ev.daaScore = <u64>daa.valueOf();
    const hash = block.getString("hash");
    if (hash != null) ev.blockHash = hash.valueOf();
  }
  ev.payload = root.getObj("payload");
  return ev;
}

// ---- entity store -------------------------------------------------------

export namespace store {
  /** Load a committed entity by (entity, id), or `null` on a miss. */
  export function get(entity: string, id: string): JSON.Obj | null {
    const eb = String.UTF8.encode(entity);
    const ib = String.UTF8.encode(id);
    const packed = host_store_get(
      changetype<i32>(eb),
      eb.byteLength,
      changetype<i32>(ib),
      ib.byteLength,
    );
    if (packed == 0) return null;
    const ptr = <i32>(packed >>> 32);
    const len = <i32>packed;
    return <JSON.Obj>JSON.parse(String.UTF8.decodeUnsafe(ptr, len));
  }

  /** Write an entity. `data` is the field object to upsert under (entity, id). */
  export function set(entity: string, id: string, data: JSON.Obj): void {
    const op = new JSON.Obj();
    op.set<string>("entity", entity);
    op.set<string>("id", id);
    op.set<JSON.Obj>("data", data);
    const buf = String.UTF8.encode(op.stringify());
    host_store_set(changetype<i32>(buf), buf.byteLength);
  }
}
