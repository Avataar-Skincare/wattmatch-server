// The routine custodian-succession path — a custodian leaves, or loses their share (with no
// suspicion it was ever seen by anyone else). Reconstructs the EXISTING key from two current
// shares and re-splits it into a fresh set of three. The underlying keypair never changes, so
// everything ever sealed under it stays openable — this is deliberately NOT the same as
// regenerate-vetting-key.mjs (the compromise-only path), which creates a brand-new, unrelated key.
//
// Run with: node scripts/reshare-vetting-key.mjs <base64-share-A> <base64-share-B> <expected-fingerprint>

import { resharePrivateKey, reconstructPrivateKey } from '../src/lib/vettingCrypto.js';
import crypto from 'node:crypto';

const [shareABase64, shareBBase64, expectedFingerprint] = process.argv.slice(2);

if (!shareABase64 || !shareBBase64 || !expectedFingerprint) {
  console.error('Usage: node scripts/reshare-vetting-key.mjs <share-A> <share-B> <expected-fingerprint>');
  process.exit(1);
}

async function main() {
  const shareA = new Uint8Array(Buffer.from(shareABase64, 'base64'));
  const shareB = new Uint8Array(Buffer.from(shareBBase64, 'base64'));

  // Verify against the expected fingerprint before proceeding — same integrity check a real
  // ceremony uses, so a wrong/corrupted share is caught here, not after re-splitting.
  await reconstructPrivateKey([shareA, shareB], expectedFingerprint);
  console.log('Fingerprint verified — proceeding to re-share.\n');

  const newShares = await resharePrivateKey([shareA, shareB]);
  console.log('New shares generated for the SAME underlying key (nothing sealed under it is affected):\n');
  newShares.forEach((share, i) => {
    console.log(`  Custodian ${i + 1} new share (base64): ${Buffer.from(share).toString('base64')}`);
    console.log(`  Custodian ${i + 1} new share checksum: ${crypto.createHash('sha256').update(share).digest('hex')}`);
  });
  console.log('\nDistribute these to the two continuing custodians plus the replacement.');
  console.log('The old shares (including the two used here) should now be destroyed.');
}

main().catch((err) => {
  console.error('Re-share failed:', err.message);
  process.exit(1);
});
