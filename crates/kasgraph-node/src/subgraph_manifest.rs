//! Rust-side view of the resolved manifest descriptor `kasgraph build`
//! writes to `build/manifest.json`. The TS CLI stays the only parser of
//! `subgraph.yaml`; the node deserializes this compact descriptor and
//! resolves which mapping handler fires for a given detector hit.

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// Manifest event names the node dispatches on. A lock-time detector hit
/// on a committed block fires the `CovenantLocked` handler.
pub const EVENT_COVENANT_LOCKED: &str = "CovenantLocked";

/// A spend that consumes a previously-locked covenant UTXO fires the
/// `CovenantSpent` handler. The detector kind used to resolve this handler
/// is the kind of the *locked* covenant being spent (carried on the lineage
/// head), so the same data source whose `patterns` matched the lock also
/// owns the spend transition.
#[allow(dead_code)]
pub const EVENT_COVENANT_SPENT: &str = "CovenantSpent";

#[derive(Debug, thiserror::Error)]
pub enum ManifestError {
    #[error("manifest descriptor not found at {0}")]
    NotFound(PathBuf),
    #[error("failed to read manifest descriptor {path}: {source}")]
    Read {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("failed to parse manifest descriptor {path}: {source}")]
    Parse {
        path: PathBuf,
        source: serde_json::Error,
    },
}

/// One handler binding: which mapping function fires for an event.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct DescriptorHandler {
    pub event: String,
    pub handler: String,
}

/// One data source: its selector(s) plus its handler bindings.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct DescriptorDataSource {
    pub name: String,
    pub kind: String,
    /// Covenant `pattern:` selectors (detector-kind names). A detector
    /// hit matches this data source when its kind is in this list.
    #[serde(default)]
    pub patterns: Vec<String>,
    #[serde(default)]
    pub collection: Option<String>,
    #[serde(default)]
    pub addresses: Vec<String>,
    #[serde(default)]
    pub handlers: Vec<DescriptorHandler>,
}

/// The resolved manifest the node loads per subgraph.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct BuildDescriptor {
    pub name: String,
    /// Wasm basename, relative to the same `build/` dir as the descriptor.
    pub wasm: String,
    #[serde(default, rename = "dataSources")]
    pub data_sources: Vec<DescriptorDataSource>,
}

impl BuildDescriptor {
    pub fn from_json(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }

    /// Load `<subgraph_dir>/build/manifest.json`.
    pub fn load(subgraph_dir: impl AsRef<Path>) -> Result<Self, ManifestError> {
        let path = subgraph_dir.as_ref().join("build").join("manifest.json");
        if !path.exists() {
            return Err(ManifestError::NotFound(path));
        }
        let json = std::fs::read_to_string(&path).map_err(|source| ManifestError::Read {
            path: path.clone(),
            source,
        })?;
        Self::from_json(&json).map_err(|source| ManifestError::Parse { path, source })
    }

    /// Absolute path to the built wasm, given the subgraph directory.
    pub fn wasm_path(&self, subgraph_dir: impl AsRef<Path>) -> PathBuf {
        subgraph_dir.as_ref().join("build").join(&self.wasm)
    }

    /// Resolve the handler that fires for a detector hit of `detector_kind`
    /// under `event` (e.g. [`EVENT_COVENANT_LOCKED`]). Returns the first
    /// match across data sources whose `patterns` include the kind. `None`
    /// means no mapping handles this hit — the caller should skip it.
    pub fn resolve_handler(&self, detector_kind: &str, event: &str) -> Option<&str> {
        for ds in &self.data_sources {
            if ds.patterns.iter().any(|p| p == detector_kind) {
                if let Some(h) = ds.handlers.iter().find(|h| h.event == event) {
                    return Some(&h.handler);
                }
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const JSON: &str = r#"{
      "name": "kasbonds",
      "wasm": "kasbonds.wasm",
      "dataSources": [
        {
          "name": "kasbonds-covenants",
          "kind": "covenant_id",
          "patterns": ["OpenSilverVault", "OpenSilverEscrowMilestone"],
          "collection": null,
          "addresses": [],
          "handlers": [
            { "event": "CovenantLocked", "handler": "handleBondIssued" },
            { "event": "CovenantSpent", "handler": "handleBondTransition" }
          ]
        }
      ]
    }"#;

    #[test]
    fn parses_the_descriptor_shape() {
        let d = BuildDescriptor::from_json(JSON).unwrap();
        assert_eq!(d.name, "kasbonds");
        assert_eq!(d.wasm, "kasbonds.wasm");
        assert_eq!(d.data_sources.len(), 1);
        assert_eq!(d.data_sources[0].kind, "covenant_id");
        assert_eq!(
            d.data_sources[0].patterns,
            vec!["OpenSilverVault", "OpenSilverEscrowMilestone"]
        );
    }

    #[test]
    fn resolve_handler_matches_pattern_then_event() {
        let d = BuildDescriptor::from_json(JSON).unwrap();
        assert_eq!(
            d.resolve_handler("OpenSilverVault", EVENT_COVENANT_LOCKED),
            Some("handleBondIssued")
        );
        assert_eq!(
            d.resolve_handler("OpenSilverEscrowMilestone", "CovenantSpent"),
            Some("handleBondTransition")
        );
    }

    #[test]
    fn resolve_handler_is_none_for_unmatched_pattern_or_event() {
        let d = BuildDescriptor::from_json(JSON).unwrap();
        // Kind not in any data source's patterns.
        assert_eq!(
            d.resolve_handler("OpenSilverMultisig", EVENT_COVENANT_LOCKED),
            None
        );
        // Pattern matches but the event has no handler.
        assert_eq!(d.resolve_handler("OpenSilverVault", "NoSuchEvent"), None);
    }

    #[test]
    fn wasm_path_joins_build_dir() {
        let d = BuildDescriptor::from_json(JSON).unwrap();
        let p = d.wasm_path("/srv/subgraphs/kasbonds");
        assert!(p.ends_with("build/kasbonds.wasm"));
    }

    #[test]
    fn missing_descriptor_is_not_found() {
        let err = BuildDescriptor::load("/nonexistent/subgraph/dir").unwrap_err();
        assert!(matches!(err, ManifestError::NotFound(_)));
    }
}
