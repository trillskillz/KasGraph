//! Emit the detector registry as JSON on stdout.
//!
//! The machine-readable catalogue of every registered detector kind
//! and the named state fields it extracts. Downstream per-detector
//! payload codegen (`@kasgraph/cli`) consumes this so generated event
//! payload types stay in lockstep with the Rust registry.
//!
//! ```sh
//! cargo run -p kasgraph-detectors --bin dump-registry > detector-schema.json
//! ```

fn main() {
    let schema = kasgraph_detectors::registry_schema();
    let json = serde_json::to_string_pretty(&schema).expect("serialize registry schema");
    println!("{json}");
}
