//! Legacy KRC-20 (Kasplex inscription-era) ledger acceptance rules.
//!
//! A pure, in-memory state machine that applies parsed
//! [`Krc20Inscription`](crate::krc20::Krc20Inscription)s in transaction
//! order and re-derives Kasplex-compatible token state (supply + per-holder
//! balances). It is deliberately storage-agnostic: the node feeds it the
//! accepted-operation stream and persists accepted ops to the
//! `kasgraph_krc20_legacy_ledger` table; reorgs roll the ledger back by
//! replaying the surviving stream (per `KRC20_KRC721_REFERENCE.md:41-55`).
//!
//! Acceptance rules implemented (Kasplex-compatible):
//!   1. `deploy` registers a tick iff no prior deploy exists
//!      (first-writer-wins); `max`/`lim` are immutable thereafter.
//!   2. `mint` credits `amt` to the sender iff
//!      `minted + amt <= max && amt <= lim`. Over-cap mints are rejected
//!      wholesale — partial mints are not allowed.
//!   3. `transfer` moves `amt` from sender to recipient iff
//!      `sender_balance >= amt`.
//!   4. `burn` decrements the sender's balance *and* cumulative minted by
//!      `amt` iff `sender_balance >= amt` (canonical Kasplex behaviour).
//!
//! Edge cases not pinned by the reference doc (e.g. zero-amount ops, a
//! `lim` exceeding `max`) follow the literal rules above; exact Kasplex
//! parity for those must be verified against the Kasplex repo before
//! shipping, as the reference notes.

use crate::krc20::{Krc20Inscription, Krc20Op};
use std::collections::BTreeMap;

/// Re-derived state of a single deployed tick.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TokenState {
    /// Total supply cap, immutable post-deploy.
    pub max: u64,
    /// Per-mint cap, immutable post-deploy.
    pub lim: u64,
    /// Cumulative amount minted so far (net of burns).
    pub minted: u64,
    /// Current balance per holder address. Zero balances are pruned.
    pub balances: BTreeMap<String, u64>,
}

/// Whether an operation was accepted into ledger state or dropped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApplyOutcome {
    /// The op mutated state and should be persisted as a ledger row.
    Accepted,
    /// The op violated an acceptance rule and left state unchanged.
    Rejected(&'static str),
}

/// In-memory legacy KRC-20 ledger: a tick registry plus per-tick state.
#[derive(Debug, Clone, Default)]
pub struct Krc20Ledger {
    tokens: BTreeMap<String, TokenState>,
}

impl Krc20Ledger {
    pub fn new() -> Self {
        Self::default()
    }

    /// Read the current state of a deployed tick, if any.
    pub fn token(&self, tick: &str) -> Option<&TokenState> {
        self.tokens.get(tick)
    }

    /// Read a holder's current balance for a tick (0 if absent).
    pub fn balance_of(&self, tick: &str, address: &str) -> u64 {
        self.tokens
            .get(tick)
            .and_then(|t| t.balances.get(address).copied())
            .unwrap_or(0)
    }

    /// Rebuild a ledger from an ordered stream of accepted ops — the pure
    /// form of the reorg / startup recovery contract. Legacy KRC-20 state
    /// is a pure function of the accepted op stream, so replaying the
    /// surviving journal rows in acceptance order reconstructs the exact
    /// in-memory state (`KRC20_KRC721_REFERENCE.md:54`): the node calls
    /// this to rebuild after a reorg unwind and to re-anchor on startup.
    ///
    /// `ops` must be in acceptance order and contain only previously
    /// accepted ops (the journal stores nothing else). Because a reorg
    /// deletes a DAA *suffix* and a tick's deploy always precedes its
    /// mints/transfers, any surviving prefix is self-consistent and every
    /// op re-applies as `Accepted`.
    pub fn replay<'a, I>(ops: I) -> Self
    where
        I: IntoIterator<Item = (&'a Krc20Inscription, &'a str)>,
    {
        let mut ledger = Self::new();
        for (inscription, sender) in ops {
            ledger.apply(inscription, sender);
        }
        ledger
    }

    /// Apply one parsed inscription as it was performed by `sender` (the
    /// transaction's first input address — the standard Kasplex
    /// convention for the operator/credited party). `deploy` ignores
    /// `sender`. Returns whether the op was accepted into state.
    pub fn apply(&mut self, inscription: &Krc20Inscription, sender: &str) -> ApplyOutcome {
        match &inscription.op {
            Krc20Op::Deploy { max, lim } => self.apply_deploy(&inscription.tick, *max, *lim),
            Krc20Op::Mint { amt } => self.apply_mint(&inscription.tick, sender, *amt),
            Krc20Op::Transfer { amt, to } => {
                self.apply_transfer(&inscription.tick, sender, to, *amt)
            }
            Krc20Op::Burn { amt } => self.apply_burn(&inscription.tick, sender, *amt),
        }
    }

    fn apply_deploy(&mut self, tick: &str, max: u64, lim: u64) -> ApplyOutcome {
        if self.tokens.contains_key(tick) {
            // First-writer-wins: a second deploy for the same tick is a no-op.
            return ApplyOutcome::Rejected("tick already deployed");
        }
        self.tokens.insert(
            tick.to_owned(),
            TokenState {
                max,
                lim,
                minted: 0,
                balances: BTreeMap::new(),
            },
        );
        ApplyOutcome::Accepted
    }

    fn apply_mint(&mut self, tick: &str, sender: &str, amt: u64) -> ApplyOutcome {
        let Some(token) = self.tokens.get_mut(tick) else {
            return ApplyOutcome::Rejected("mint for undeployed tick");
        };
        if amt > token.lim {
            return ApplyOutcome::Rejected("mint exceeds per-mint limit");
        }
        // Over-cap mints are rejected wholesale (no partial mint). Use a
        // checked add so a crafted amt can't wrap past the cap check.
        match token.minted.checked_add(amt) {
            Some(total) if total <= token.max => {
                token.minted = total;
                *token.balances.entry(sender.to_owned()).or_insert(0) += amt;
                ApplyOutcome::Accepted
            }
            _ => ApplyOutcome::Rejected("mint exceeds total supply cap"),
        }
    }

    fn apply_transfer(&mut self, tick: &str, sender: &str, to: &str, amt: u64) -> ApplyOutcome {
        let Some(token) = self.tokens.get_mut(tick) else {
            return ApplyOutcome::Rejected("transfer for undeployed tick");
        };
        let sender_balance = token.balances.get(sender).copied().unwrap_or(0);
        if sender_balance < amt {
            return ApplyOutcome::Rejected("transfer exceeds sender balance");
        }
        debit(&mut token.balances, sender, amt);
        *token.balances.entry(to.to_owned()).or_insert(0) += amt;
        ApplyOutcome::Accepted
    }

    fn apply_burn(&mut self, tick: &str, sender: &str, amt: u64) -> ApplyOutcome {
        let Some(token) = self.tokens.get_mut(tick) else {
            return ApplyOutcome::Rejected("burn for undeployed tick");
        };
        let sender_balance = token.balances.get(sender).copied().unwrap_or(0);
        if sender_balance < amt {
            return ApplyOutcome::Rejected("burn exceeds sender balance");
        }
        debit(&mut token.balances, sender, amt);
        // Canonical Kasplex decrements cumulative minted on burn. Balances
        // always sum to `minted`, so this cannot underflow.
        token.minted = token.minted.saturating_sub(amt);
        ApplyOutcome::Accepted
    }
}

/// Subtract `amt` from `address`'s balance, pruning the entry when it
/// reaches zero so holder counts (`COUNT(*)`) stay accurate.
fn debit(balances: &mut BTreeMap<String, u64>, address: &str, amt: u64) {
    if let Some(balance) = balances.get_mut(address) {
        *balance -= amt;
        if *balance == 0 {
            balances.remove(address);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deploy(tick: &str, max: u64, lim: u64) -> Krc20Inscription {
        Krc20Inscription {
            tick: tick.to_owned(),
            tick_raw: tick.to_uppercase(),
            op: Krc20Op::Deploy { max, lim },
        }
    }
    fn mint(tick: &str, amt: u64) -> Krc20Inscription {
        Krc20Inscription {
            tick: tick.to_owned(),
            tick_raw: tick.to_uppercase(),
            op: Krc20Op::Mint { amt },
        }
    }
    fn transfer(tick: &str, amt: u64, to: &str) -> Krc20Inscription {
        Krc20Inscription {
            tick: tick.to_owned(),
            tick_raw: tick.to_uppercase(),
            op: Krc20Op::Transfer {
                amt,
                to: to.to_owned(),
            },
        }
    }
    fn burn(tick: &str, amt: u64) -> Krc20Inscription {
        Krc20Inscription {
            tick: tick.to_owned(),
            tick_raw: tick.to_uppercase(),
            op: Krc20Op::Burn { amt },
        }
    }

    #[test]
    fn deploy_registers_a_tick_first_writer_wins() {
        let mut l = Krc20Ledger::new();
        assert_eq!(
            l.apply(&deploy("test", 1000, 100), "alice"),
            ApplyOutcome::Accepted
        );
        let t = l.token("test").unwrap();
        assert_eq!((t.max, t.lim, t.minted), (1000, 100, 0));
        // Second deploy of the same tick is rejected and does not alter state.
        assert!(matches!(
            l.apply(&deploy("test", 9, 9), "bob"),
            ApplyOutcome::Rejected(_)
        ));
        let t = l.token("test").unwrap();
        assert_eq!((t.max, t.lim), (1000, 100));
    }

    #[test]
    fn mint_credits_sender_within_caps() {
        let mut l = Krc20Ledger::new();
        l.apply(&deploy("test", 1000, 100), "x");
        assert_eq!(l.apply(&mint("test", 100), "alice"), ApplyOutcome::Accepted);
        assert_eq!(l.apply(&mint("test", 50), "alice"), ApplyOutcome::Accepted);
        assert_eq!(l.balance_of("test", "alice"), 150);
        assert_eq!(l.token("test").unwrap().minted, 150);
    }

    #[test]
    fn mint_over_per_mint_limit_is_rejected_wholesale() {
        let mut l = Krc20Ledger::new();
        l.apply(&deploy("test", 1000, 100), "x");
        assert!(matches!(
            l.apply(&mint("test", 101), "alice"),
            ApplyOutcome::Rejected(_)
        ));
        assert_eq!(l.balance_of("test", "alice"), 0);
        assert_eq!(l.token("test").unwrap().minted, 0);
    }

    #[test]
    fn mint_over_total_cap_is_rejected_wholesale() {
        let mut l = Krc20Ledger::new();
        l.apply(&deploy("test", 120, 100), "x");
        assert_eq!(l.apply(&mint("test", 100), "alice"), ApplyOutcome::Accepted);
        // 100 + 50 = 150 > 120 cap → rejected entirely, no partial credit.
        assert!(matches!(
            l.apply(&mint("test", 50), "alice"),
            ApplyOutcome::Rejected(_)
        ));
        assert_eq!(l.balance_of("test", "alice"), 100);
        assert_eq!(l.token("test").unwrap().minted, 100);
    }

    #[test]
    fn mint_for_undeployed_tick_is_rejected() {
        let mut l = Krc20Ledger::new();
        assert!(matches!(
            l.apply(&mint("ghost", 1), "alice"),
            ApplyOutcome::Rejected(_)
        ));
    }

    #[test]
    fn transfer_moves_balance_when_funded() {
        let mut l = Krc20Ledger::new();
        l.apply(&deploy("test", 1000, 1000), "x");
        l.apply(&mint("test", 100), "alice");
        assert_eq!(
            l.apply(&transfer("test", 40, "bob"), "alice"),
            ApplyOutcome::Accepted
        );
        assert_eq!(l.balance_of("test", "alice"), 60);
        assert_eq!(l.balance_of("test", "bob"), 40);
        // Total supply is unchanged by a transfer.
        assert_eq!(l.token("test").unwrap().minted, 100);
    }

    #[test]
    fn transfer_exceeding_balance_is_rejected() {
        let mut l = Krc20Ledger::new();
        l.apply(&deploy("test", 1000, 1000), "x");
        l.apply(&mint("test", 30), "alice");
        assert!(matches!(
            l.apply(&transfer("test", 31, "bob"), "alice"),
            ApplyOutcome::Rejected(_)
        ));
        assert_eq!(l.balance_of("test", "alice"), 30);
        assert_eq!(l.balance_of("test", "bob"), 0);
    }

    #[test]
    fn transfer_draining_balance_prunes_the_sender_entry() {
        let mut l = Krc20Ledger::new();
        l.apply(&deploy("test", 1000, 1000), "x");
        l.apply(&mint("test", 40), "alice");
        l.apply(&transfer("test", 40, "bob"), "alice");
        assert!(l.token("test").unwrap().balances.get("alice").is_none());
        assert_eq!(l.balance_of("test", "bob"), 40);
    }

    #[test]
    fn burn_decrements_balance_and_cumulative_minted() {
        let mut l = Krc20Ledger::new();
        l.apply(&deploy("test", 1000, 1000), "x");
        l.apply(&mint("test", 100), "alice");
        assert_eq!(l.apply(&burn("test", 30), "alice"), ApplyOutcome::Accepted);
        assert_eq!(l.balance_of("test", "alice"), 70);
        assert_eq!(l.token("test").unwrap().minted, 70);
    }

    #[test]
    fn burn_exceeding_balance_is_rejected() {
        let mut l = Krc20Ledger::new();
        l.apply(&deploy("test", 1000, 1000), "x");
        l.apply(&mint("test", 10), "alice");
        assert!(matches!(
            l.apply(&burn("test", 11), "alice"),
            ApplyOutcome::Rejected(_)
        ));
        assert_eq!(l.token("test").unwrap().minted, 10);
    }

    #[test]
    fn supply_equals_sum_of_balances_across_an_op_stream() {
        // Property the table relies on: minted == sum(balances) after any
        // accepted mint/transfer/burn sequence, so burn can't underflow.
        let mut l = Krc20Ledger::new();
        l.apply(&deploy("t", 10_000, 10_000), "x");
        l.apply(&mint("t", 500), "alice");
        l.apply(&mint("t", 300), "bob");
        l.apply(&transfer("t", 200, "carol"), "alice");
        l.apply(&burn("t", 100), "bob");
        let t = l.token("t").unwrap();
        let sum: u64 = t.balances.values().sum();
        assert_eq!(sum, t.minted);
        assert_eq!(t.minted, 500 + 300 - 100);
    }

    #[test]
    fn replay_reconstructs_the_same_state_as_incremental_apply() {
        let ops = [
            (deploy("t", 10_000, 10_000), "x"),
            (mint("t", 500), "alice"),
            (mint("t", 300), "bob"),
            (transfer("t", 200, "carol"), "alice"),
            (burn("t", 100), "bob"),
        ];
        let mut incremental = Krc20Ledger::new();
        for (ins, sender) in &ops {
            incremental.apply(ins, sender);
        }
        let replayed = Krc20Ledger::replay(ops.iter().map(|(ins, sender)| (ins, *sender)));
        assert_eq!(incremental.token("t"), replayed.token("t"));
    }

    #[test]
    fn replaying_the_daa_surviving_prefix_models_a_reorg_unwind() {
        // (inscription, sender, accepting_daa) — the daa is the test's
        // stand-in for the journal's `accepting_daa_score`.
        let stream = [
            (deploy("t", 10_000, 10_000), "x", 10u64),
            (mint("t", 500), "alice", 11),
            (mint("t", 300), "bob", 12),
            (transfer("t", 200, "carol"), "alice", 13),
        ];
        // A reorg deletes every row at or above daa 12, then the survivors
        // are re-replayed — exactly `unwind_krc20_legacy_ledger` followed by
        // `Krc20Ledger::replay`.
        let survivors = stream
            .iter()
            .filter(|(_, _, daa)| *daa < 12)
            .map(|(ins, sender, _)| (ins, *sender));
        let ledger = Krc20Ledger::replay(survivors);
        // Only the deploy + alice's 500 mint survive; bob's mint and the
        // transfer are gone.
        assert_eq!(ledger.balance_of("t", "alice"), 500);
        assert_eq!(ledger.balance_of("t", "bob"), 0);
        assert_eq!(ledger.balance_of("t", "carol"), 0);
        assert_eq!(ledger.token("t").unwrap().minted, 500);
    }
}
