// Creates a vetting custodian — one of the (normally 3) people who each hold a Shamir share of the
// technical AND financial custodian keys (see src/lib/vettingCrypto.ts). Deliberately NOT a web
// endpoint, same out-of-band-only convention as the key-lifecycle scripts (generate-vetting-
// keypairs.mjs, reshare-vetting-key.mjs) — a custodian's authority comes from holding a real key
// share, not from any Wattmatch login, so provisioning them stays outside the app entirely.
//
// Run with: node scripts/create-vetting-custodian.mjs <name> <email>

import 'dotenv/config';
import { VettingCustodian } from '../src/models/VettingCustodian.js';

const [name, email] = process.argv.slice(2);

if (!name || !email) {
  console.error('Usage: node scripts/create-vetting-custodian.mjs <name> <email>');
  process.exit(1);
}

async function main() {
  const existing = await VettingCustodian.findOne({ where: { email } });
  if (existing) {
    console.error(`A custodian already exists for ${email} (id=${existing.id}).`);
    process.exit(1);
  }

  const custodian = await VettingCustodian.create({ name, email });
  console.log(`Custodian created: id=${custodian.id}, name=${name}, email=${email}`);
  console.log('They will receive a ceremony link by email automatically when a tender\'s scheduled opening date arrives.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Failed to create custodian:', err.message);
    process.exit(1);
  });
