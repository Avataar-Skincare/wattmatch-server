// One-time ceremony script: generates BOTH the technical and financial keypairs, splits each into
// three shares, and prints everything needed to configure the server plus hand shares to the three
// real custodians. Run with: node scripts/generate-vetting-keypairs.mjs
//
// IMPORTANT: this generates PLACEHOLDER key material unless run with real custodians present to
// receive the shares immediately. Never run this against production data with placeholder
// custodians — see VETTING_BID_SEALING_IMPLEMENTATION_PLAN.md's custodian-retention note. The raw
// private keys never touch disk at any point — only the already-split shares are ever printed.

import { generateVettingKeypair } from '../src/lib/vettingCrypto.js';

function printKey(label, result) {
  console.log(`\n=== ${label} ===`);
  console.log(`Public key (safe to store in config / publish):\n${result.publicKeyPem}`);
  console.log(`Fingerprint (store in config as VETTING_${label.toUpperCase()}_PUBLIC_KEY_FINGERPRINT):\n${result.fingerprint}\n`);
  console.log(`Three shares — hand exactly ONE to each of the three named custodians, never keep two together:`);
  result.shares.forEach((share, i) => {
    console.log(`  Custodian ${i + 1} share (base64): ${Buffer.from(share).toString('base64')}`);
    console.log(`  Custodian ${i + 1} share checksum (for their own self-check later): ${result.shareChecksums[i]}`);
  });
}

async function main() {
  console.log('Generating technical and financial keypairs — this is a placeholder ceremony unless');
  console.log('real custodians are present right now to receive these shares immediately.\n');

  const technical = await generateVettingKeypair();
  const financial = await generateVettingKeypair();

  printKey('technical', technical);
  printKey('financial', financial);

  console.log('\nNothing above is written to disk by this script — copy what you need now.');
}

main().catch((err) => {
  console.error('Key generation failed:', err.message);
  process.exit(1);
});
