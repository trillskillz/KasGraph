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
//! This crate currently exposes the surface KasGraph Node will call:
//!   - `MappingRuntime::new(wasm_bytes)` to instantiate a sandbox.
//!   - `MappingRuntime::dispatch(event)` to fire a typed event into a
//!     subgraph handler.
//!
//! The actual WASM execution engine (wasmtime or wasmer) is chosen in
//! Phase 2.6; this crate keeps the API surface independent of that
//! choice so we can A/B them under one workspace.

use thiserror::Error;

#[derive(Debug, Error)]
pub enum MappingError {
    #[error("mapping rejected event: handler `{handler}` returned trap: {message}")]
    HandlerTrap { handler: String, message: String },

    #[error("mapping is non-deterministic: {0}")]
    Nondeterministic(String),

    #[error("mapping ABI mismatch: {0}")]
    AbiMismatch(String),
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
    /// dispatch to.
    pub handler: String,
}

/// Stub runtime. The real WASM engine + deterministic-execution
/// constraints land in Phase 2.6.
pub struct MappingRuntime {
    pub wasm_bytes: Vec<u8>,
}

impl MappingRuntime {
    pub fn new(wasm_bytes: Vec<u8>) -> Self {
        Self { wasm_bytes }
    }

    /// Dispatch a typed event to a subgraph handler. Currently a
    /// no-op; returns Ok to keep dependents buildable.
    pub fn dispatch(&self, _event: MappingEvent) -> Result<(), MappingError> {
        Ok(())
    }
}
