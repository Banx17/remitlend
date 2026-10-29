/**
 * Stores the loan manager's fixed-point accrual index snapshots (#1382).
 *
 * The loan manager publishes an `accrue` event whenever it settles an
 * accrual window. The event carries the loan's cumulative index, the index
 * delta of the window, the interest the window produced and the sub-stroop
 * residual that was carried into the next window. Indexing those snapshots
 * lets the backend reproduce the contract's own accrual off-chain instead of
 * re-deriving it from a single one-shot formula, which drifted whenever a
 * loan was repaid in more than one instalment.
 *
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
export const up = (pgm) => {
  pgm.createTable(
    'interest_index',
    {
      id: { type: 'bigserial', primaryKey: true },
      loan_id: { type: 'integer', notNull: true },
      ledger: { type: 'integer', notNull: true },
      // The index and its deltas are 1e18 scaled integers, so they are
      // stored as exact numeric integers rather than floats.
      index_value: { type: 'numeric(40, 0)', notNull: true },
      index_delta: { type: 'numeric(40, 0)', notNull: true },
      // Interest is stored in whole stroops, the residual in millionths of
      // a stroop.
      interest_delta: { type: 'numeric(40, 0)', notNull: true, default: 0 },
      residual: { type: 'numeric(40, 0)', notNull: true, default: 0 },
      event_id: { type: 'text' },
      tx_hash: { type: 'text' },
      created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    },
    { ifNotExists: true },
  );

  // One snapshot per accrue event: re-indexing a ledger is a no-op.
  pgm.addConstraint('interest_index', 'interest_index_event_id_key', { unique: 'event_id' });
  pgm.createIndex('interest_index', ['loan_id', 'ledger'], {
    name: 'idx_interest_index_loan_ledger',
  });
  pgm.createIndex('interest_index', 'tx_hash', { name: 'idx_interest_index_tx_hash' });
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) => {
  pgm.dropTable('interest_index');
};
