/**
 * One-off backfill that encrypts the PII that is still stored in cleartext.
 *
 * `userController.updateUserProfile` used to write the e-mail address and
 * the phone number of a user in cleartext (#1828). Those rows are encrypted
 * here with the piiCrypto envelope and the legacy plaintext columns are
 * cleared afterwards.
 *
 * Usage: `npm run pii:backfill`
 */
import { closePool } from '../db/connection.js';
import { backfillUserProfilePii } from '../services/userProfilePii.js';

async function main(): Promise<void> {
  const { scanned, encrypted } = await backfillUserProfilePii();

  process.stdout.write(
    `user profile PII backfill complete: ${encrypted}/${scanned} rows encrypted\n`,
  );
}

main()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (error) => {
    process.stderr.write(
      `user profile PII backfill failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    await closePool();
    process.exit(1);
  });
