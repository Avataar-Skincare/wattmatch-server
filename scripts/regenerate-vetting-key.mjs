// The compromise-only path — a share is confirmed leaked, or there's real reason to believe an
// attacker could gather two of the three. Generates a genuinely NEW, mathematically unrelated
// keypair. This does NOT preserve access to anything sealed under the OLD key — that is
// mathematically impossible, not a limitation of this script. Any tender still pending under the
// old key needs urgent opening (see the emergency fast-open path) or generator resubmission before
// this is run, not after.
//
// Run with: node scripts/regenerate-vetting-key.mjs

import { generateVettingKeypair } from '../src/lib/vettingCrypto.js';

async function main() {
  console.log('!!! COMPROMISE-ONLY PATH !!!');
  console.log('This generates a BRAND NEW key. Anything sealed under the OLD key becomes permanently');
  console.log('unreadable through this new one — that is mathematically unavoidable, not a bug.');
  console.log('Confirm any pending tenders under the old key have already been opened urgently or');
  console.log('their generators notified to resubmit, BEFORE relying on this new key.\n');

  const result = await generateVettingKeypair();

  console.log(`New public key:\n${result.publicKeyPem}`);
  console.log(`New fingerprint: ${result.fingerprint}\n`);
  console.log('Three NEW shares — hand exactly one to each of the three named custodians:');
  result.shares.forEach((share, i) => {
    console.log(`  Custodian ${i + 1} share (base64): ${Buffer.from(share).toString('base64')}`);
    console.log(`  Custodian ${i + 1} share checksum: ${result.shareChecksums[i]}`);
  });

  console.log('\nThis is a security incident, not a quiet operational fix — this event should trigger');
  console.log('the CERT-In 6-hour breach-reporting obligation, per BID_SEALING_BUILD_CHECKLIST.md.');
}

main().catch((err) => {
  console.error('Key regeneration failed:', err.message);
  process.exit(1);
});
