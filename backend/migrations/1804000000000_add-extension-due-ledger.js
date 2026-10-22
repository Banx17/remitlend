/**
 * Stores the absolute due ledger emitted by LoanExtended events. Keeping this
 * separately from term_ledgers preserves the meaning of LoanApproved data.
 *
 * The backward-compat `loan_events` view is dropped and recreated instead of
 * being replaced in place: the view that the previous migration left behind
 * exposes `address AS borrower`, so `CREATE OR REPLACE VIEW` would try to
 * rename the view column "borrower" to "address" and Postgres rejects that
 * with `42P16: cannot change name of view column "borrower" to "address"`.
 * @param {import('node-pg-migrate').MigrationBuilder} pgm
 */
export const up = (pgm) => {
  pgm.addColumn('contract_events', {
    due_ledger: { type: 'integer' },
  });
  pgm.createIndex('contract_events', 'id', {
    name: 'idx_contract_events_legacy_extensions_due_ledger',
    where: "event_type = 'LoanExtended' AND due_ledger IS NULL",
  });

  pgm.sql('DROP VIEW IF EXISTS loan_events;');
  pgm.sql(`
    CREATE VIEW loan_events AS
    SELECT
      id,
      event_id,
      event_type,
      loan_id,
      address,
      address AS borrower,
      amount,
      interest_rate_bps,
      term_ledgers,
      ledger,
      ledger_closed_at,
      tx_hash,
      contract_id,
      topics,
      value,
      created_at,
      due_ledger
    FROM contract_events;
  `);
};

/** @param {import('node-pg-migrate').MigrationBuilder} pgm */
export const down = (pgm) => {
  pgm.sql('DROP VIEW IF EXISTS loan_events;');
  pgm.dropIndex('contract_events', 'id', {
    name: 'idx_contract_events_legacy_extensions_due_ledger',
  });
  // Restore the view exactly as the previous migration left it, so the
  // rollback is the inverse of `up`.
  pgm.sql(`
    CREATE VIEW loan_events AS
    SELECT
      id,
      event_id,
      event_type,
      loan_id,
      address AS borrower,
      amount,
      ledger,
      ledger_closed_at,
      tx_hash,
      contract_id,
      topics,
      value,
      created_at
    FROM contract_events;
  `);
  pgm.dropColumn('contract_events', 'due_ledger');
};
