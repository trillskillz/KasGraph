//! kasgraph-mapping — WASM mapping runtime.
//!
//! Per `PLAN.md` Phase 2.6:
//!   - TypeScript mappings compile to WASM via AssemblyScript.
//!   - Sandboxed execution per block.
//!   - Strict deterministic execution.
//!   - Subgraph manifest compatible with The Graph format where
//!     reasonable (for migration ease — see Phase 1.1 reference doc
//!     `docs/references/THEGRAPH_REFERENCE.md`).
//!
//! ## Host engine
//!
//! wasmtime is the chosen host engine. It is the Bytecode Alliance
//! flagship and exposes the determinism controls a per-block indexer
//! needs: fuel metering (bounded execution, no runaway handler stalls
//! the indexer), Cranelift NaN canonicalization (float results are
//! bit-identical across machines), and opt-out of the nondeterministic
//! proposals (threads, relaxed-SIMD). Each block dispatch runs in a
//! fresh `Store`, so handlers cannot carry hidden state across blocks.
//!
//! ## ABI
//!
//! A subgraph WASM module (produced by `kasgraph build` from an
//! AssemblyScript mapping, or hand-written) must export:
//!   - `memory`               — the linear memory.
//!   - `kasgraph_alloc(i32) -> i32`
//!         allocate `len` bytes in guest memory and return the pointer;
//!         the host writes the event JSON there before calling a handler.
//!   - one function per manifest handler, e.g.
//!         `handleCovenantLocked(ptr: i32, len: i32)`
//!         receives a pointer + length to the UTF-8 event JSON.
//!
//! The guest may import (module `kasgraph`):
//!   - `log(level: i32, ptr: i32, len: i32)`
//!         emit a log line (UTF-8 bytes at `ptr..ptr+len`).
//!   - `store_set(ptr: i32, len: i32)`
//!         emit an entity write. The bytes are JSON of the shape
//!         `{ "entity": string, "id": string, "data": object }`.
//!
//! The host hands each handler a JSON document shaped as
//! `{ "block": { "daaScore", "hash" }, "payload": <detector payload> }`.

use serde::{Deserialize, Serialize};
use thiserror::Error;
use wasmtime::{
    Caller, Config, Engine, Error as WasmError, Extern, Linker, Module, Result as WasmResult,
    Store, Trap,
};

#[derive(Debug, Error)]
pub enum MappingError {
    #[error("mapping rejected event: handler `{handler}` trapped: {message}")]
    HandlerTrap { handler: String, message: String },

    #[error(
        "mapping handler `{handler}` exhausted its fuel budget — \
         possible infinite loop or runaway computation"
    )]
    FuelExhausted { handler: String },

    #[error("mapping is non-deterministic: {0}")]
    Nondeterministic(String),

    #[error("mapping ABI mismatch: {0}")]
    AbiMismatch(String),

    #[error("mapping emitted a malformed entity write: {0}")]
    DecodePayload(String),

    #[error("mapping engine error: {0}")]
    Engine(String),
}

/// A typed event handed to a subgraph mapping. Wraps the
/// pattern-detected event from `kasgraph-detectors` plus block context.
#[derive(Debug, Clone)]
pub struct MappingEvent {
    pub block_daa_score: u64,
    pub block_hash: String,
    /// Serialized detector payload — the mapping receives this in its
    /// own typed shape via codegen from `schema.graphql`.
    pub payload: serde_json::Value,
    /// The handler name from the subgraph manifest the runtime should
    /// dispatch to. Must match an exported function on the guest.
    pub handler: String,
}

/// One entity write emitted by a handler via `kasgraph.store_set`.
/// This is the unit the store layer upserts per block.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EntityOp {
    pub entity: String,
    pub id: String,
    #[serde(default)]
    pub data: serde_json::Value,
}

/// One log line emitted by a handler via `kasgraph.log`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MappingLog {
    pub level: i32,
    pub message: String,
}

/// Everything a single handler dispatch produced.
#[derive(Debug, Clone, Default)]
pub struct DispatchOutcome {
    pub logs: Vec<MappingLog>,
    pub entity_ops: Vec<EntityOp>,
    /// Fuel consumed by this dispatch. Useful for budgeting/metering.
    pub fuel_consumed: u64,
}

/// Per-dispatch host state, threaded through wasmtime as the `Store`
/// data so host import calls can accumulate their effects.
#[derive(Default)]
struct HostState {
    logs: Vec<MappingLog>,
    entity_ops: Vec<EntityOp>,
    /// Set when `store_set` receives malformed JSON, so a resulting
    /// trap can be reported as a precise `DecodePayload` error.
    decode_error: Option<String>,
}

/// Default fuel budget per dispatch. Generous enough for real mapping
/// work, bounded enough that an infinite loop trips within ms.
const DEFAULT_FUEL: u64 = 50_000_000;

/// A compiled, sandboxed subgraph mapping. Compile once; dispatch many
/// events. Each dispatch runs in a fresh `Store` for isolation.
pub struct MappingRuntime {
    engine: Engine,
    module: Module,
    linker: Linker<HostState>,
    fuel_limit: u64,
}

impl MappingRuntime {
    /// Compile a subgraph mapping from WASM bytes (or, in tests, WAT
    /// text — wasmtime parses both). Validates the required ABI exports
    /// up front so handler dispatch can assume them.
    pub fn from_wasm(wasm: impl AsRef<[u8]>) -> Result<Self, MappingError> {
        let mut config = Config::new();
        // Determinism + safety knobs.
        config.consume_fuel(true);
        config.cranelift_nan_canonicalization(true);
        config.wasm_threads(false);
        config.wasm_relaxed_simd(false);

        let engine = Engine::new(&config).map_err(|e| MappingError::Engine(e.to_string()))?;
        let module = Module::new(&engine, wasm)
            .map_err(|e| MappingError::Engine(format!("failed to compile module: {e}")))?;

        if module.get_export("memory").is_none() {
            return Err(MappingError::AbiMismatch(
                "guest module does not export `memory`".into(),
            ));
        }
        if module.get_export("kasgraph_alloc").is_none() {
            return Err(MappingError::AbiMismatch(
                "guest module does not export `kasgraph_alloc(i32) -> i32`".into(),
            ));
        }

        let mut linker = Linker::new(&engine);
        register_host_functions(&mut linker)?;

        Ok(Self {
            engine,
            module,
            linker,
            fuel_limit: DEFAULT_FUEL,
        })
    }

    /// Override the per-dispatch fuel budget.
    pub fn with_fuel(mut self, fuel: u64) -> Self {
        self.fuel_limit = fuel;
        self
    }

    /// Dispatch a typed event to the named subgraph handler. Runs in a
    /// fresh `Store`; returns everything the handler emitted, or a
    /// classified error (trap, fuel exhaustion, ABI mismatch, …).
    pub fn dispatch(&self, event: MappingEvent) -> Result<DispatchOutcome, MappingError> {
        let mut store = Store::new(&self.engine, HostState::default());
        store
            .set_fuel(self.fuel_limit)
            .map_err(|e| MappingError::Engine(e.to_string()))?;

        let instance = self
            .linker
            .instantiate(&mut store, &self.module)
            .map_err(|e| MappingError::Engine(format!("instantiation failed: {e}")))?;

        let memory = instance
            .get_memory(&mut store, "memory")
            .ok_or_else(|| MappingError::AbiMismatch("guest missing `memory` export".into()))?;
        let alloc = instance
            .get_typed_func::<i32, i32>(&mut store, "kasgraph_alloc")
            .map_err(|e| {
                MappingError::AbiMismatch(format!("`kasgraph_alloc` has the wrong signature: {e}"))
            })?;
        let handler = instance
            .get_typed_func::<(i32, i32), ()>(&mut store, &event.handler)
            .map_err(|_| {
                MappingError::AbiMismatch(format!(
                    "guest has no handler export `{}`",
                    event.handler
                ))
            })?;

        let input = serde_json::to_vec(&serde_json::json!({
            "block": {
                "daaScore": event.block_daa_score,
                "hash": event.block_hash,
            },
            "payload": event.payload,
        }))
        .map_err(|e| MappingError::Engine(e.to_string()))?;
        let len = i32::try_from(input.len())
            .map_err(|_| MappingError::Engine("event JSON exceeds i32 length".into()))?;

        let ptr = alloc
            .call(&mut store, len)
            .map_err(|e| classify_trap(&event.handler, &e))?;
        memory
            .write(&mut store, ptr as usize, &input)
            .map_err(|e| {
                MappingError::AbiMismatch(format!(
                    "`kasgraph_alloc` returned an out-of-bounds pointer: {e}"
                ))
            })?;

        if let Err(e) = handler.call(&mut store, (ptr, len)) {
            if let Some(decode_error) = store.data().decode_error.clone() {
                return Err(MappingError::DecodePayload(decode_error));
            }
            return Err(classify_trap(&event.handler, &e));
        }

        let remaining = store.get_fuel().unwrap_or(0);
        let fuel_consumed = self.fuel_limit.saturating_sub(remaining);
        let state = store.into_data();
        Ok(DispatchOutcome {
            logs: state.logs,
            entity_ops: state.entity_ops,
            fuel_consumed,
        })
    }
}

fn register_host_functions(linker: &mut Linker<HostState>) -> Result<(), MappingError> {
    let wrap = |linker: &mut Linker<HostState>| -> WasmResult<()> {
        linker.func_wrap(
            "kasgraph",
            "log",
            |mut caller: Caller<'_, HostState>, level: i32, ptr: i32, len: i32| -> WasmResult<()> {
                let bytes = read_guest_bytes(&mut caller, ptr, len)?;
                let message = String::from_utf8_lossy(&bytes).into_owned();
                caller.data_mut().logs.push(MappingLog { level, message });
                Ok(())
            },
        )?;
        linker.func_wrap(
            "kasgraph",
            "store_set",
            |mut caller: Caller<'_, HostState>, ptr: i32, len: i32| -> WasmResult<()> {
                let bytes = read_guest_bytes(&mut caller, ptr, len)?;
                match serde_json::from_slice::<EntityOp>(&bytes) {
                    Ok(op) => {
                        caller.data_mut().entity_ops.push(op);
                        Ok(())
                    }
                    Err(e) => {
                        let msg = format!("store_set received malformed entity-op JSON: {e}");
                        caller.data_mut().decode_error = Some(msg.clone());
                        Err(WasmError::msg(msg))
                    }
                }
            },
        )?;
        Ok(())
    };
    wrap(linker).map_err(|e| MappingError::Engine(e.to_string()))
}

/// Read `len` bytes at `ptr` out of the guest's exported linear memory.
fn read_guest_bytes(caller: &mut Caller<'_, HostState>, ptr: i32, len: i32) -> WasmResult<Vec<u8>> {
    let memory = caller
        .get_export("memory")
        .and_then(Extern::into_memory)
        .ok_or_else(|| WasmError::msg("guest has no `memory` export"))?;
    let data = memory.data(&caller);
    let start = usize::try_from(ptr).map_err(|_| WasmError::msg("negative pointer"))?;
    let len = usize::try_from(len).map_err(|_| WasmError::msg("negative length"))?;
    let end = start
        .checked_add(len)
        .ok_or_else(|| WasmError::msg("pointer + length overflows"))?;
    data.get(start..end)
        .map(<[u8]>::to_vec)
        .ok_or_else(|| WasmError::msg(format!("guest pointer {start}..{end} is out of bounds")))
}

/// Map a wasmtime call error into a `MappingError`, distinguishing fuel
/// exhaustion (a bounded-execution signal) from a genuine handler trap.
fn classify_trap(handler: &str, err: &WasmError) -> MappingError {
    if let Some(trap) = err.downcast_ref::<Trap>() {
        if *trap == Trap::OutOfFuel {
            return MappingError::FuelExhausted {
                handler: handler.to_string(),
            };
        }
    }
    MappingError::HandlerTrap {
        handler: handler.to_string(),
        message: err.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(handler: &str) -> MappingEvent {
        MappingEvent {
            block_daa_score: 444_000_000,
            block_hash: "abcd".into(),
            payload: serde_json::json!({ "detectorKind": "OpenSilverVault" }),
            handler: handler.into(),
        }
    }

    // A guest exporting the full ABI. `handleLock` emits one canned
    // entity op; `handleLog` logs; `handleBoom` traps; `handleLoop`
    // spins forever (fuel exhaustion). The entity-op JSON lives at
    // offset 0 (42 bytes); the bump allocator hands out memory from
    // 1024 up, so the host-written event JSON never clobbers it.
    const WAT_FULL: &str = r#"
        (module
          (import "kasgraph" "store_set" (func $store_set (param i32 i32)))
          (import "kasgraph" "log" (func $log (param i32 i32 i32)))
          (memory (export "memory") 1)
          (global $heap (mut i32) (i32.const 1024))
          (func (export "kasgraph_alloc") (param $len i32) (result i32)
            (local $p i32)
            (local.set $p (global.get $heap))
            (global.set $heap (i32.add (global.get $heap) (local.get $len)))
            (local.get $p))
          (data (i32.const 0) "{\"entity\":\"Bond\",\"id\":\"b1\",\"data\":{\"x\":1}}")
          (data (i32.const 64) "hi")
          (func (export "handleLock") (param i32 i32)
            (call $store_set (i32.const 0) (i32.const 42)))
          (func (export "handleLog") (param i32 i32)
            (call $log (i32.const 7) (i32.const 64) (i32.const 2)))
          (func (export "handleBoom") (param i32 i32)
            (unreachable))
          (func (export "handleLoop") (param i32 i32)
            (loop $l (br $l)))
          (data (i32.const 128) "{\"entity\":\"Bond\"}")
          (func (export "handleBadOp") (param i32 i32)
            (call $store_set (i32.const 128) (i32.const 17)))
        )
    "#;

    #[test]
    fn store_set_surfaces_one_entity_op() {
        let rt = MappingRuntime::from_wasm(WAT_FULL).unwrap();
        let out = rt.dispatch(event("handleLock")).unwrap();
        assert_eq!(out.entity_ops.len(), 1);
        assert_eq!(out.entity_ops[0].entity, "Bond");
        assert_eq!(out.entity_ops[0].id, "b1");
        assert_eq!(out.entity_ops[0].data, serde_json::json!({ "x": 1 }));
        assert!(out.logs.is_empty());
        assert!(out.fuel_consumed > 0, "a real dispatch must burn fuel");
    }

    #[test]
    fn log_is_captured_with_level() {
        let rt = MappingRuntime::from_wasm(WAT_FULL).unwrap();
        let out = rt.dispatch(event("handleLog")).unwrap();
        assert_eq!(out.logs.len(), 1);
        assert_eq!(out.logs[0].level, 7);
        assert_eq!(out.logs[0].message, "hi");
        assert!(out.entity_ops.is_empty());
    }

    #[test]
    fn handler_trap_is_classified() {
        let rt = MappingRuntime::from_wasm(WAT_FULL).unwrap();
        let err = rt.dispatch(event("handleBoom")).unwrap_err();
        match err {
            MappingError::HandlerTrap { handler, .. } => assert_eq!(handler, "handleBoom"),
            other => panic!("expected HandlerTrap, got {other:?}"),
        }
    }

    #[test]
    fn infinite_loop_exhausts_fuel() {
        let rt = MappingRuntime::from_wasm(WAT_FULL)
            .unwrap()
            .with_fuel(1_000_000);
        let err = rt.dispatch(event("handleLoop")).unwrap_err();
        match err {
            MappingError::FuelExhausted { handler } => assert_eq!(handler, "handleLoop"),
            other => panic!("expected FuelExhausted, got {other:?}"),
        }
    }

    #[test]
    fn malformed_entity_op_is_a_decode_error() {
        // `{"entity":"Bond"}` is missing the required `id` field.
        let rt = MappingRuntime::from_wasm(WAT_FULL).unwrap();
        let err = rt.dispatch(event("handleBadOp")).unwrap_err();
        match err {
            MappingError::DecodePayload(msg) => assert!(msg.contains("store_set")),
            other => panic!("expected DecodePayload, got {other:?}"),
        }
    }

    #[test]
    fn missing_handler_export_is_abi_mismatch() {
        let rt = MappingRuntime::from_wasm(WAT_FULL).unwrap();
        let err = rt.dispatch(event("handleNope")).unwrap_err();
        match err {
            MappingError::AbiMismatch(msg) => assert!(msg.contains("handleNope")),
            other => panic!("expected AbiMismatch, got {other:?}"),
        }
    }

    #[test]
    fn module_without_memory_is_rejected_at_compile() {
        let wat = r#"
            (module
              (func (export "kasgraph_alloc") (param i32) (result i32) (i32.const 0))
              (func (export "handleLock") (param i32 i32)))
        "#;
        match MappingRuntime::from_wasm(wat) {
            Err(MappingError::AbiMismatch(msg)) => assert!(msg.contains("memory")),
            Err(other) => panic!("expected AbiMismatch, got {other:?}"),
            Ok(_) => panic!("expected AbiMismatch, module compiled"),
        }
    }

    #[test]
    fn module_without_alloc_is_rejected_at_compile() {
        let wat = r#"
            (module
              (memory (export "memory") 1)
              (func (export "handleLock") (param i32 i32)))
        "#;
        match MappingRuntime::from_wasm(wat) {
            Err(MappingError::AbiMismatch(msg)) => assert!(msg.contains("kasgraph_alloc")),
            Err(other) => panic!("expected AbiMismatch, got {other:?}"),
            Ok(_) => panic!("expected AbiMismatch, module compiled"),
        }
    }

    #[test]
    fn dispatch_is_deterministic_across_runs() {
        let rt = MappingRuntime::from_wasm(WAT_FULL).unwrap();
        let a = rt.dispatch(event("handleLock")).unwrap();
        let b = rt.dispatch(event("handleLock")).unwrap();
        // Same module, same event -> identical effects and identical fuel.
        assert_eq!(a.entity_ops, b.entity_ops);
        assert_eq!(a.fuel_consumed, b.fuel_consumed);
    }

    #[test]
    fn fresh_store_isolates_state_between_dispatches() {
        // Two dispatches must not accumulate; each starts empty.
        let rt = MappingRuntime::from_wasm(WAT_FULL).unwrap();
        let a = rt.dispatch(event("handleLock")).unwrap();
        let b = rt.dispatch(event("handleLock")).unwrap();
        assert_eq!(a.entity_ops.len(), 1);
        assert_eq!(b.entity_ops.len(), 1);
    }
}
