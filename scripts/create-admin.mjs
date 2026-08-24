// Creates a WattMatch internal admin/ops account — deliberately NOT reachable through the public
// registration form (routes/organizations.ts only allows 'buyer'/'generator' there). Admins create
// tenders with real per-tender pricing (routes/tenders.ts), so this account type is created
// out-of-band by whoever runs this script, not self-served.
//
// Run with: node scripts/create-admin.mjs <name> <email> <phone> <password>

import 'dotenv/config';
import { Organization } from '../src/models/Organization.js';
import { hashPassword } from '../src/lib/passwordAuth.js';

const [name, email, phone, password] = process.argv.slice(2);

if (!name || !email || !phone || !password) {
  console.error('Usage: node scripts/create-admin.mjs <name> <email> <phone> <password>');
  process.exit(1);
}
if (password.length < 10) {
  console.error('Password must be at least 10 characters (same policy as every other org login).');
  process.exit(1);
}

async function main() {
  const existing = await Organization.findOne({ where: { contactEmail: email } });
  if (existing) {
    console.error(`An organization already exists for ${email} (type: ${existing.type}).`);
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  const admin = await Organization.create({
    type: 'admin',
    name,
    contactEmail: email,
    contactPhone: phone,
    passwordHash,
    emailVerified: true, // created out-of-band by a trusted operator — no verification email needed
  });

  console.log(`Admin account created: id=${admin.id}, email=${email}`);
  console.log('Log in via POST /api/organizations/login with this email/password, same as any other org.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Failed to create admin:', err.message);
    process.exit(1);
  });
