// Standalone self-check a custodian can run at any time to confirm their own share is still
// intact — without needing the actual private key or any other custodian. Run with:
//   node scripts/verify-vetting-share.mjs <base64-share> <expected-checksum>
// Catches corruption early (bit rot, a bad copy-paste) instead of discovering it during a real
// opening ceremony, the worst possible moment to find out.

import { shareChecksum } from '../src/lib/vettingCrypto.js';

const [shareBase64, expectedChecksum] = process.argv.slice(2);

if (!shareBase64 || !expectedChecksum) {
  console.error('Usage: node scripts/verify-vetting-share.mjs <base64-share> <expected-checksum>');
  process.exit(1);
}

const share = new Uint8Array(Buffer.from(shareBase64, 'base64'));
const actual = shareChecksum(share);

if (actual === expectedChecksum) {
  console.log('OK — this share matches its recorded checksum. It is intact.');
} else {
  console.log('MISMATCH — this share does NOT match its recorded checksum.');
  console.log('It may be corrupted, truncated, or copied incorrectly. Do not rely on it for a real');
  console.log('ceremony without first confirming with whoever holds the original record.');
  process.exit(1);
}
