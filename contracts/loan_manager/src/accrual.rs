//! Accrual index plumbing for the loan manager (issue #1382).
//!
//! The loan manager accrues simple interest over the term of a loan: a
//! fixed rate (in basis points) is charged on the *remaining* principal and
//! spread evenly across the term's ledgers. Historically the contract
//! evaluated that formula directly, and the backend/frontend each
//! re-implemented it in their own integer type - which is how the off-chain
//! owed amount could drift away from the on-chain owed amount (#1382).
//!
//! This module introduces the canonical *index* that all three layers share:
//!
//! * the index is a `1e18` scaled accumulator of `rate x time`. It starts at
//!   [`INDEX_SCALE`] (`1.0`) and grows by `rate_bps / 10_000 * elapsed` for
//!   every ledger a loan is outstanding,
//! * the interest of an accrual window is derived from the *difference*
//!   between the index at the end and at the beginning of that window,
//! * every accrual publishes the resulting index in the `accrue` event, so
//!   an indexer can replay the exact windows the contract settled and
//!   reproduce its numbers bit-for-bit.
//!
//! The index is persisted per loan, together with the ledger it was
//! committed at, so a loan that is settled in several windows keeps the
//! index of its last settlement. Loans that were originated before the index
//! existed fall back to [`INDEX_SCALE`] and a ledger of `0`, so they keep
//! working unchanged. The pool-wide reference index and the anchor a loan
//! records at origination are persisted alongside it.

use crate::{DataKey, LoanError};
use money::accrual::{self, INDEX_SCALE};
use soroban_sdk::Env;

/// The loan's accrual index at `to_ledger`.
///
/// `from_ledger` is the ledger the previous accrual settled at, `to_ledger`
/// the ledger the current one settles at. The index is `1.0` (i.e.
/// [`INDEX_SCALE`]) when no time has passed.
pub fn loan_index(rate_bps: u32, from_ledger: u32, to_ledger: u32) -> Result<i128, LoanError> {
    if to_ledger <= from_ledger {
        return Ok(INDEX_SCALE);
    }
    let elapsed = (to_ledger - from_ledger) as i128;
    let delta = accrual::index_delta(rate_bps, elapsed).map_err(|_| LoanError::IndexOverflow)?;
    accrual::advance_index(INDEX_SCALE, delta).map_err(|_| LoanError::IndexOverflow)
}

/// The pool-wide reference index.
///
/// The reference index tracks the *configured* borrow rate (the rate the
/// pool would charge a freshly approved loan), so it can be compared against
/// a loan's own index to show whether that loan was priced above or below
/// the current market. It is persisted together with the ledger it was last
/// advanced to, and is advanced lazily whenever it is read.
pub fn read_borrow_index(env: &Env) -> (i128, u32) {
    let index = env
        .storage()
        .instance()
        .get::<_, i128>(&DataKey::BorrowIndex)
        .unwrap_or(INDEX_SCALE);
    let ledger = env
        .storage()
        .instance()
        .get::<_, u32>(&DataKey::BorrowIndexLedger)
        .unwrap_or(0);
    (index, ledger)
}

/// Persist the pool-wide reference index.
pub fn write_borrow_index(env: &Env, index: i128, ledger: u32) {
    env.storage().instance().set(&DataKey::BorrowIndex, &index);
    env.storage()
        .instance()
        .set(&DataKey::BorrowIndexLedger, &ledger);
}

/// The loan's cumulative accrual index and the ledger it was committed at.
///
/// The index defaults to [`INDEX_SCALE`] (i.e. "no rate accrued yet") for
/// loans that were originated before the index existed; the ledger defaults
/// to `0` in that case as well.
pub fn read_loan_index(env: &Env, loan_id: u32) -> (i128, u32) {
    let index = env
        .storage()
        .persistent()
        .get(&DataKey::LoanIndex(loan_id))
        .unwrap_or(INDEX_SCALE);
    let ledger = env
        .storage()
        .persistent()
        .get(&DataKey::LoanIndexLedger(loan_id))
        .unwrap_or(0);
    (index, ledger)
}

/// Persist the loan's cumulative accrual index and the ledger it belongs to.
pub fn write_loan_index(env: &Env, loan_id: u32, index: i128, ledger: u32) {
    env.storage()
        .persistent()
        .set(&DataKey::LoanIndex(loan_id), &index);
    env.storage()
        .persistent()
        .set(&DataKey::LoanIndexLedger(loan_id), &ledger);
}

/// The index a loan was originated at.
///
/// A loan records the pool-wide reference index that was current when it was
/// approved; the difference between that anchor and the pool's reference
/// index today is the rate drift the loan was priced against.
pub fn read_loan_index_origin(env: &Env, loan_id: u32) -> i128 {
    env.storage()
        .persistent()
        .get(&DataKey::LoanIndexOrigin(loan_id))
        .unwrap_or(INDEX_SCALE)
}

/// Persist the index a loan was originated at.
pub fn write_loan_index_origin(env: &Env, loan_id: u32, index: i128) {
    env.storage()
        .persistent()
        .set(&DataKey::LoanIndexOrigin(loan_id), &index);
}
