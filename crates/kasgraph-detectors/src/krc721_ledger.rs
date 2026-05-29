//! Legacy KRC-721 (Kasplex inscription-era) ownership acceptance rules.
//!
//! A pure, in-memory NFT-ownership state machine that applies parsed
//! [`Krc721Inscription`](crate::krc721::Krc721Inscription)s in transaction
//! order. It mirrors [`crate::krc20_ledger`] in spirit but tracks
//! per-token ownership rather than fungible balances. Accepted ops are
//! journaled in the `kasgraph_krc721_legacy_ledger` store table and this
//! state is rebuilt by replaying them in acceptance order, per
//! `docs/references/KRC20_KRC721_REFERENCE.md:58-74`.
//!
//! Acceptance rules (mirroring legacy KRC-20):
//!   1. `deploy` registers a collection iff none exists for the tick
//!      (first-writer-wins); `max` is immutable thereafter.
//!   2. `mint` assigns token `id` to the sender iff the collection exists,
//!      `id < max`, and the id has never been minted before (uniqueness is
//!      permanent — a burned id cannot be re-minted).
//!   3. `transfer` reassigns token `id` to the recipient iff the sender
//!      currently owns it.
//!   4. `burn` destroys token `id` iff the sender currently owns it; the id
//!      stays consumed so it can never be minted again.

use crate::krc721::{Krc721Inscription, Krc721Op};
use std::collections::{BTreeMap, BTreeSet};

/// Re-derived state of a single deployed collection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CollectionState {
    /// Token-count cap, immutable post-deploy. Valid ids are `0..max`.
    pub max: u64,
    /// Current owner per live token id. Burned tokens are removed here.
    pub owners: BTreeMap<u64, String>,
    /// Every token id ever minted (live or burned). Enforces permanent
    /// uniqueness: an id in this set can never be minted again.
    pub minted: BTreeSet<u64>,
}

/// Whether an operation was accepted into ledger state or dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyOutcome {
    /// The op mutated state and should be persisted as a ledger row.
    Accepted,
    /// The op violated an acceptance rule and left state unchanged.
    Rejected(&'static str),
}

/// In-memory legacy KRC-721 ledger: a collection registry plus per-token
/// ownership.
#[derive(Debug, Clone, Default)]
pub struct Krc721Ledger {
    collections: BTreeMap<String, CollectionState>,
}

impl Krc721Ledger {
    pub fn new() -> Self {
        Self::default()
    }

    /// Read the current state of a deployed collection, if any.
    pub fn collection(&self, tick: &str) -> Option<&CollectionState> {
        self.collections.get(tick)
    }

    /// Read the current owner of a token, if it is live.
    pub fn owner_of(&self, tick: &str, id: u64) -> Option<&str> {
        self.collections
            .get(tick)
            .and_then(|c| c.owners.get(&id))
            .map(String::as_str)
    }

    /// Apply one parsed inscription as it was performed by `sender` (the
    /// transaction's first input address — the standard Kasplex
    /// convention for the operator/owner). `deploy` ignores `sender`.
    pub fn apply(&mut self, inscription: &Krc721Inscription, sender: &str) -> ApplyOutcome {
        match &inscription.op {
            Krc721Op::Deploy { max } => self.apply_deploy(&inscription.tick, *max),
            Krc721Op::Mint { id, .. } => self.apply_mint(&inscription.tick, sender, *id),
            Krc721Op::Transfer { id, to } => {
                self.apply_transfer(&inscription.tick, sender, to, *id)
            }
            Krc721Op::Burn { id } => self.apply_burn(&inscription.tick, sender, *id),
        }
    }

    fn apply_deploy(&mut self, tick: &str, max: u64) -> ApplyOutcome {
        if self.collections.contains_key(tick) {
            return ApplyOutcome::Rejected("collection already deployed");
        }
        self.collections.insert(
            tick.to_owned(),
            CollectionState {
                max,
                owners: BTreeMap::new(),
                minted: BTreeSet::new(),
            },
        );
        ApplyOutcome::Accepted
    }

    fn apply_mint(&mut self, tick: &str, sender: &str, id: u64) -> ApplyOutcome {
        let Some(collection) = self.collections.get_mut(tick) else {
            return ApplyOutcome::Rejected("mint for undeployed collection");
        };
        if id >= collection.max {
            return ApplyOutcome::Rejected("token id outside collection size");
        }
        if collection.minted.contains(&id) {
            return ApplyOutcome::Rejected("token id already minted");
        }
        collection.minted.insert(id);
        collection.owners.insert(id, sender.to_owned());
        ApplyOutcome::Accepted
    }

    fn apply_transfer(&mut self, tick: &str, sender: &str, to: &str, id: u64) -> ApplyOutcome {
        let Some(collection) = self.collections.get_mut(tick) else {
            return ApplyOutcome::Rejected("transfer for undeployed collection");
        };
        match collection.owners.get(&id) {
            Some(owner) if owner == sender => {
                collection.owners.insert(id, to.to_owned());
                ApplyOutcome::Accepted
            }
            _ => ApplyOutcome::Rejected("transfer of a token the sender does not own"),
        }
    }

    fn apply_burn(&mut self, tick: &str, sender: &str, id: u64) -> ApplyOutcome {
        let Some(collection) = self.collections.get_mut(tick) else {
            return ApplyOutcome::Rejected("burn for undeployed collection");
        };
        match collection.owners.get(&id) {
            Some(owner) if owner == sender => {
                // Drop ownership but keep the id in `minted` so it can
                // never be re-minted.
                collection.owners.remove(&id);
                ApplyOutcome::Accepted
            }
            _ => ApplyOutcome::Rejected("burn of a token the sender does not own"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deploy(tick: &str, max: u64) -> Krc721Inscription {
        Krc721Inscription {
            tick: tick.to_owned(),
            tick_raw: tick.to_uppercase(),
            op: Krc721Op::Deploy { max },
        }
    }
    fn mint(tick: &str, id: u64) -> Krc721Inscription {
        Krc721Inscription {
            tick: tick.to_owned(),
            tick_raw: tick.to_uppercase(),
            op: Krc721Op::Mint {
                id,
                uri: "ipfs://meta".to_owned(),
            },
        }
    }
    fn transfer(tick: &str, id: u64, to: &str) -> Krc721Inscription {
        Krc721Inscription {
            tick: tick.to_owned(),
            tick_raw: tick.to_uppercase(),
            op: Krc721Op::Transfer {
                id,
                to: to.to_owned(),
            },
        }
    }
    fn burn(tick: &str, id: u64) -> Krc721Inscription {
        Krc721Inscription {
            tick: tick.to_owned(),
            tick_raw: tick.to_uppercase(),
            op: Krc721Op::Burn { id },
        }
    }

    #[test]
    fn deploy_registers_a_collection_first_writer_wins() {
        let mut l = Krc721Ledger::new();
        assert_eq!(
            l.apply(&deploy("punks", 100), "alice"),
            ApplyOutcome::Accepted
        );
        assert_eq!(l.collection("punks").unwrap().max, 100);
        assert!(matches!(
            l.apply(&deploy("punks", 5), "bob"),
            ApplyOutcome::Rejected(_)
        ));
        assert_eq!(l.collection("punks").unwrap().max, 100);
    }

    #[test]
    fn mint_assigns_ownership_within_collection_size() {
        let mut l = Krc721Ledger::new();
        l.apply(&deploy("punks", 100), "x");
        assert_eq!(l.apply(&mint("punks", 0), "alice"), ApplyOutcome::Accepted);
        assert_eq!(l.owner_of("punks", 0), Some("alice"));
    }

    #[test]
    fn mint_outside_collection_size_is_rejected() {
        let mut l = Krc721Ledger::new();
        l.apply(&deploy("punks", 10), "x");
        // Valid ids are 0..10, so id 10 is out of range.
        assert!(matches!(
            l.apply(&mint("punks", 10), "alice"),
            ApplyOutcome::Rejected(_)
        ));
        assert_eq!(l.owner_of("punks", 10), None);
    }

    #[test]
    fn minting_the_same_id_twice_is_rejected() {
        let mut l = Krc721Ledger::new();
        l.apply(&deploy("punks", 100), "x");
        l.apply(&mint("punks", 7), "alice");
        assert!(matches!(
            l.apply(&mint("punks", 7), "bob"),
            ApplyOutcome::Rejected(_)
        ));
        // Original owner unchanged.
        assert_eq!(l.owner_of("punks", 7), Some("alice"));
    }

    #[test]
    fn mint_for_undeployed_collection_is_rejected() {
        let mut l = Krc721Ledger::new();
        assert!(matches!(
            l.apply(&mint("ghost", 1), "alice"),
            ApplyOutcome::Rejected(_)
        ));
    }

    #[test]
    fn transfer_reassigns_ownership_when_owned() {
        let mut l = Krc721Ledger::new();
        l.apply(&deploy("punks", 100), "x");
        l.apply(&mint("punks", 1), "alice");
        assert_eq!(
            l.apply(&transfer("punks", 1, "bob"), "alice"),
            ApplyOutcome::Accepted
        );
        assert_eq!(l.owner_of("punks", 1), Some("bob"));
    }

    #[test]
    fn transfer_by_non_owner_is_rejected() {
        let mut l = Krc721Ledger::new();
        l.apply(&deploy("punks", 100), "x");
        l.apply(&mint("punks", 1), "alice");
        assert!(matches!(
            l.apply(&transfer("punks", 1, "carol"), "mallory"),
            ApplyOutcome::Rejected(_)
        ));
        assert_eq!(l.owner_of("punks", 1), Some("alice"));
    }

    #[test]
    fn transfer_of_unminted_token_is_rejected() {
        let mut l = Krc721Ledger::new();
        l.apply(&deploy("punks", 100), "x");
        assert!(matches!(
            l.apply(&transfer("punks", 5, "bob"), "alice"),
            ApplyOutcome::Rejected(_)
        ));
    }

    #[test]
    fn burn_destroys_a_token_the_sender_owns() {
        let mut l = Krc721Ledger::new();
        l.apply(&deploy("punks", 100), "x");
        l.apply(&mint("punks", 3), "alice");
        assert_eq!(l.apply(&burn("punks", 3), "alice"), ApplyOutcome::Accepted);
        assert_eq!(l.owner_of("punks", 3), None);
    }

    #[test]
    fn burn_by_non_owner_is_rejected() {
        let mut l = Krc721Ledger::new();
        l.apply(&deploy("punks", 100), "x");
        l.apply(&mint("punks", 3), "alice");
        assert!(matches!(
            l.apply(&burn("punks", 3), "bob"),
            ApplyOutcome::Rejected(_)
        ));
        assert_eq!(l.owner_of("punks", 3), Some("alice"));
    }

    #[test]
    fn a_burned_id_can_never_be_re_minted() {
        let mut l = Krc721Ledger::new();
        l.apply(&deploy("punks", 100), "x");
        l.apply(&mint("punks", 3), "alice");
        l.apply(&burn("punks", 3), "alice");
        // The id is consumed permanently — re-mint is rejected.
        assert!(matches!(
            l.apply(&mint("punks", 3), "bob"),
            ApplyOutcome::Rejected(_)
        ));
        assert_eq!(l.owner_of("punks", 3), None);
    }
}
