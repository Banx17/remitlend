import type { Request, Response } from 'express';
import { query } from '../db/connection.js';
import { AppError } from '../errors/AppError.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import type { UpdateUserProfileInput } from '../schemas/userSchemas.js';
import {
  encryptPiiValue,
  piiColumnNames,
  readPiiValue,
  type PiiField,
  type UserProfilePiiRow,
} from '../services/userProfilePii.js';

interface UserProfileRow extends UserProfilePiiRow {
  id: number;
  public_key: string;
  display_name: string | null;
  email_enabled?: boolean | null;
  sms_enabled?: boolean | null;
  created_at: Date | string;
  updated_at: Date | string;
  metadata: Record<string, unknown> | null;
}

function metadataFrom(row: UserProfileRow): Record<string, unknown> {
  return row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function serializeProfile(row: UserProfileRow, req: Request) {
  const metadata = metadataFrom(row);
  const publicKey = row.public_key;

  // The e-mail address and the phone number are stored as an envelope
  // encrypted ciphertext; they are only decrypted for the owner of the
  // profile and every decryption is audited in `pii_access_log` (#1828).
  const piiContext = {
    recordId: publicKey,
    actor: publicKey,
    reason: 'profile read by owner',
    requestId: req.requestId ?? 'unknown',
  };

  const email = await readPiiValue(row, 'email', piiContext);
  const phone = await readPiiValue(row, 'phone', piiContext);

  return {
    id: String(row.id),
    email: email ?? '',
    walletAddress: row.public_key,
    kycVerified: Boolean(metadata.kycVerified ?? metadata.kyc_verified ?? false),
    displayName: row.display_name ?? '',
    phone: phone ?? '',
    locale: typeof metadata.locale === 'string' ? metadata.locale : undefined,
    avatarUrl:
      typeof metadata.avatarUrl === 'string'
        ? metadata.avatarUrl
        : typeof metadata.avatar_url === 'string'
          ? metadata.avatar_url
          : undefined,
    emailEnabled: Boolean(row.email_enabled),
    smsEnabled: Boolean(row.sms_enabled),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

async function getOrCreateProfile(publicKey: string): Promise<UserProfileRow> {
  const result = await query(
    `WITH inserted AS (
       INSERT INTO user_profiles (public_key, metadata)
       VALUES ($1, '{}'::jsonb)
       ON CONFLICT (public_key) DO NOTHING
       RETURNING *
     )
     SELECT * FROM inserted
     UNION ALL
     SELECT * FROM user_profiles WHERE public_key = $1
     LIMIT 1`,
    [publicKey],
  );

  const profile = result.rows[0] as UserProfileRow | undefined;
  if (!profile) {
    throw AppError.internal('Unable to load user profile');
  }

  return profile;
}

/**
 * Builds the `SET` fragments that persist an encrypted PII value.
 *
 * A value is encrypted with the piiCrypto envelope (random DEK, wrapped by
 * the KEK) and the legacy plaintext column is cleared in the same statement,
 * so a PII value is never written to the database in cleartext (#1828).
 */
async function buildPiiUpdates(
  input: UpdateUserProfileInput,
  startParamIndex: number,
): Promise<{ updates: string[]; values: unknown[]; nextParamIndex: number }> {
  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIndex = startParamIndex;

  const fields: Array<{ field: PiiField; value: string | null | undefined }> = [
    { field: 'email', value: input.email },
    { field: 'phone', value: input.phone },
  ];

  for (const { field, value } of fields) {
    if (value === undefined) continue;

    const columns = piiColumnNames(field);
    const legacyColumn = field;

    if (value === null || value === '') {
      // The value was cleared: drop the envelope and the legacy column.
      updates.push(
        `${columns.ciphertext} = NULL`,
        `${columns.nonce} = NULL`,
        `${columns.dek} = NULL`,
        `${columns.kek} = NULL`,
        `${legacyColumn} = NULL`,
      );
      continue;
    }

    const encrypted = await encryptPiiValue(value);
    updates.push(
      `${columns.ciphertext} = $${paramIndex++}`,
      `${columns.nonce} = $${paramIndex++}`,
      `${columns.dek} = $${paramIndex++}`,
      `${columns.kek} = $${paramIndex++}`,
      `${legacyColumn} = NULL`,
    );
    values.push(
      encrypted.ciphertext,
      encrypted.gcm_nonce,
      encrypted.dek_wrapped,
      encrypted.dek_kek_id,
    );
  }

  return { updates, values, nextParamIndex: paramIndex };
}

export const getUserProfile = asyncHandler(async (req: Request, res: Response) => {
  const publicKey = req.user?.publicKey;
  if (!publicKey) {
    throw AppError.unauthorized('Authentication required');
  }

  const profile = await getOrCreateProfile(publicKey);
  res.json(await serializeProfile(profile, req));
});

export const updateUserProfile = asyncHandler(async (req: Request, res: Response) => {
  const publicKey = req.user?.publicKey;
  if (!publicKey) {
    throw AppError.unauthorized('Authentication required');
  }

  const input = req.body as UpdateUserProfileInput;
  const current = await getOrCreateProfile(publicKey);
  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (input.displayName !== undefined) {
    updates.push(`display_name = $${paramIndex++}`);
    values.push(input.displayName);
  }

  // The e-mail address and the phone number are PII: they are encrypted with
  // the piiCrypto envelope before they are persisted, and the legacy
  // plaintext columns are cleared so nothing is stored in cleartext (#1828).
  const piiUpdates = await buildPiiUpdates(input, paramIndex);
  updates.push(...piiUpdates.updates);
  values.push(...piiUpdates.values);
  paramIndex = piiUpdates.nextParamIndex;

  if (input.locale !== undefined || input.avatarUrl !== undefined) {
    const metadata = { ...metadataFrom(current) };

    if (input.locale === null) {
      delete metadata.locale;
    } else if (input.locale !== undefined) {
      metadata.locale = input.locale;
    }

    if (input.avatarUrl === null) {
      delete metadata.avatarUrl;
      delete metadata.avatar_url;
    } else if (input.avatarUrl !== undefined) {
      metadata.avatarUrl = input.avatarUrl;
      delete metadata.avatar_url;
    }

    updates.push(`metadata = $${paramIndex++}::jsonb`);
    values.push(JSON.stringify(metadata));
  }

  if (updates.length === 0) {
    res.json(await serializeProfile(current, req));
    return;
  }

  updates.push('updated_at = CURRENT_TIMESTAMP');
  values.push(publicKey);

  const result = await query(
    `UPDATE user_profiles
     SET ${updates.join(', ')}
     WHERE public_key = $${paramIndex}
     RETURNING *`,
    values,
  );

  const updated = result.rows[0] as UserProfileRow | undefined;
  if (!updated) {
    throw AppError.notFound('User profile not found');
  }

  res.json(await serializeProfile(updated, req));
});
