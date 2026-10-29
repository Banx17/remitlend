/**
 * User profile PII encryption
 *
 * `user_profiles` used to store the e-mail address and the phone number of a
 * user in cleartext, even though the backend ships an AES-256-GCM envelope
 * encryption service (`backend/src/services/piiCrypto.ts`) - see #1828.
 *
 * This migration adds the envelope columns that hold the encrypted values:
 * one ciphertext, one GCM nonce, one wrapped DEK and the KEK identifier per
 * PII field. The legacy plaintext columns (`email`, `phone`) are kept so the
 * one-off backfill (`npm run pii:backfill`) can migrate the existing rows;
 * the application itself never writes to them again.
 *
 * @type {import('node-pg-migrate').ColumnDefinitions | undefined}
 */
export const shorthands = undefined;

const EMAIL_COLUMNS = {
  email_ciphertext: {
    type: 'bytea',
    comment: 'AES-256-GCM ciphertext of the user e-mail address',
  },
  email_gcm_nonce: {
    type: 'bytea',
    comment: 'GCM nonce used to encrypt the user e-mail address',
  },
  email_dek_wrapped: {
    type: 'bytea',
    comment: 'Data encryption key of the e-mail address, wrapped by the KEK',
  },
  email_dek_kek_id: {
    type: 'text',
    comment: 'Identifier of the KEK that wraps the e-mail data encryption key',
  },
};

const PHONE_COLUMNS = {
  phone_ciphertext: {
    type: 'bytea',
    comment: 'AES-256-GCM ciphertext of the user phone number',
  },
  phone_gcm_nonce: {
    type: 'bytea',
    comment: 'GCM nonce used to encrypt the user phone number',
  },
  phone_dek_wrapped: {
    type: 'bytea',
    comment: 'Data encryption key of the phone number, wrapped by the KEK',
  },
  phone_dek_kek_id: {
    type: 'text',
    comment: 'Identifier of the KEK that wraps the phone data encryption key',
  },
};

const ALL_COLUMNS = { ...EMAIL_COLUMNS, ...PHONE_COLUMNS };

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const up = (pgm) => {
  pgm.addColumns('user_profiles', ALL_COLUMNS);
};

/**
 * @param pgm {import('node-pg-migrate').MigrationBuilder}
 * @returns {Promise<void> | void}
 */
export const down = (pgm) => {
  pgm.dropColumns('user_profiles', Object.keys(ALL_COLUMNS));
};
