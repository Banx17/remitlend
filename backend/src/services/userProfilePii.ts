import { query } from '../db/connection.js';
import { decryptField, encryptField } from './piiCrypto.js';
import logger from '../utils/logger.js';

/**
 * Envelope encryption helpers for the PII columns of `user_profiles`.
 *
 * The e-mail address and the phone number are stored as an AES-256-GCM
 * envelope: a random data encryption key (DEK) encrypts the value, the DEK
 * itself is wrapped by the KEK and every decryption is written to
 * `pii_access_log` - see `backend/src/services/piiCrypto.ts` and #1828.
 */

export type PiiField = 'email' | 'phone';

export interface EncryptedPiiValue {
  ciphertext: Buffer;
  gcm_nonce: Buffer;
  dek_wrapped: Buffer;
  dek_kek_id: string;
}

export interface UserProfilePiiRow {
  email?: string | null;
  phone?: string | null;
  email_ciphertext?: Buffer | null;
  email_gcm_nonce?: Buffer | null;
  email_dek_wrapped?: Buffer | null;
  email_dek_kek_id?: string | null;
  phone_ciphertext?: Buffer | null;
  phone_gcm_nonce?: Buffer | null;
  phone_dek_wrapped?: Buffer | null;
  phone_dek_kek_id?: string | null;
}

export interface PiiReadContext {
  /** The row identifier used in the `pii_access_log` audit trail. */
  recordId: string;
  /** Who asked for the plaintext (the user themselves, or a service). */
  actor: string;
  /** Why the plaintext was needed. */
  reason: string;
  /** Correlates the audit entry with the HTTP request. */
  requestId: string;
}

/**
 * The four columns that hold the envelope of a single PII field.
 */
export function piiColumnNames(field: PiiField): {
  ciphertext: string;
  nonce: string;
  dek: string;
  kek: string;
} {
  return {
    ciphertext: `${field}_ciphertext`,
    nonce: `${field}_gcm_nonce`,
    dek: `${field}_dek_wrapped`,
    kek: `${field}_dek_kek_id`,
  };
}

/**
 * Encrypts a PII value into the four envelope columns.
 */
export async function encryptPiiValue(value: string): Promise<EncryptedPiiValue> {
  const encrypted = await encryptField(value);

  return {
    ciphertext: encrypted.ciphertext,
    gcm_nonce: encrypted.gcm_nonce,
    dek_wrapped: encrypted.dek_wrapped,
    dek_kek_id: encrypted.dek_kek_id,
  };
}

/**
 * Reads a PII value from a `user_profiles` row.
 *
 * Rows that were written before the encryption migration still carry the
 * legacy plaintext column; those are returned as-is so the profile keeps
 * working until the backfill has encrypted them.
 */
export async function readPiiValue(
  row: UserProfilePiiRow,
  field: PiiField,
  context: PiiReadContext,
): Promise<string | null> {
  const columns = piiColumnNames(field);
  const envelope = row as unknown as Record<string, unknown>;
  const ciphertext = envelope[columns.ciphertext];
  const nonce = envelope[columns.nonce];
  const dekWrapped = envelope[columns.dek];
  const kekId = envelope[columns.kek];

  if (
    Buffer.isBuffer(ciphertext) &&
    Buffer.isBuffer(nonce) &&
    Buffer.isBuffer(dekWrapped) &&
    typeof kekId === 'string' &&
    kekId.length > 0
  ) {
    return decryptField(
      context.recordId,
      field,
      ciphertext,
      nonce,
      dekWrapped,
      kekId,
      context.actor,
      context.reason,
      context.requestId,
    );
  }

  const legacyPlaintext = row[field];
  return legacyPlaintext ? legacyPlaintext : null;
}

/**
 * Encrypts every plaintext PII value that is still stored in cleartext and
 * clears the legacy columns afterwards.
 *
 * Used by the one-off backfill (`npm run pii:backfill`); it is idempotent
 * because rows that are already encrypted are skipped.
 */
export async function backfillUserProfilePii(): Promise<{ scanned: number; encrypted: number }> {
  const result = await query(
    `SELECT public_key, email, phone,
            email_ciphertext, phone_ciphertext
       FROM user_profiles
      WHERE (email IS NOT NULL AND email <> '' AND email_ciphertext IS NULL)
         OR (phone IS NOT NULL AND phone <> '' AND phone_ciphertext IS NULL)`,
    [],
  );

  let encrypted = 0;

  for (const row of result.rows as Array<{
    public_key: string;
    email: string | null;
    phone: string | null;
    email_ciphertext: Buffer | null;
    phone_ciphertext: Buffer | null;
  }>) {
    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (row.email && !row.email_ciphertext) {
      const value = await encryptPiiValue(row.email);
      const columns = piiColumnNames('email');
      updates.push(
        `${columns.ciphertext} = $${paramIndex++}`,
        `${columns.nonce} = $${paramIndex++}`,
        `${columns.dek} = $${paramIndex++}`,
        `${columns.kek} = $${paramIndex++}`,
        'email = NULL',
      );
      values.push(value.ciphertext, value.gcm_nonce, value.dek_wrapped, value.dek_kek_id);
    }

    if (row.phone && !row.phone_ciphertext) {
      const value = await encryptPiiValue(row.phone);
      const columns = piiColumnNames('phone');
      updates.push(
        `${columns.ciphertext} = $${paramIndex++}`,
        `${columns.nonce} = $${paramIndex++}`,
        `${columns.dek} = $${paramIndex++}`,
        `${columns.kek} = $${paramIndex++}`,
        'phone = NULL',
      );
      values.push(value.ciphertext, value.gcm_nonce, value.dek_wrapped, value.dek_kek_id);
    }

    if (updates.length === 0) continue;

    updates.push('updated_at = CURRENT_TIMESTAMP');
    values.push(row.public_key);

    await query(
      `UPDATE user_profiles
       SET ${updates.join(', ')}
       WHERE public_key = $${paramIndex}`,
      values,
    );

    encrypted += 1;
  }

  logger.withContext().info('user profile PII backfill finished', {
    scanned: result.rows.length,
    encrypted,
  });

  return { scanned: result.rows.length, encrypted };
}
