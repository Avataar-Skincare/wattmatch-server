// Creates a generator account directly, bypassing the public self-registration flow's email
// verification step (see routes/organizations.ts) — same shortcut create-admin.mjs takes for admin
// accounts, useful for local dev/testing so you don't have to click a verification link that may
// not even send locally (SMTP not configured). The account works immediately either way: nothing
// downstream gates on emailVerified yet (see that route's own comment).
//
// Run with: node scripts/create-generator.mjs <name> <email> <phone> <password> <capacityMw>

import 'dotenv/config';
import { Organization } from '../src/models/Organization.js';
import { hashPassword } from '../src/lib/passwordAuth.js';

const [name, email, phone, password, capacityMw] = process.argv.slice(2);

if (!name || !email || !phone || !password || !capacityMw) {
  console.error('Usage: node scripts/create-generator.mjs <name> <email> <phone> <password> <capacityMw>');
  process.exit(1);
}
if (password.length < 10) {
  console.error('Password must be at least 10 characters (same policy as every other org login).');
  process.exit(1);
}
if (!Number.isFinite(Number(capacityMw)) || Number(capacityMw) <= 0) {
  console.error('capacityMw must be a positive number.');
  process.exit(1);
}

async function main() {
  const existing = await Organization.findOne({ where: { contactEmail: email } });
  if (existing) {
    console.error(`An organization already exists for ${email} (type: ${existing.type}).`);
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);
  const generator = await Organization.create({
    type: 'generator',
    name,
    contactEmail: email,
    contactPhone: phone,
    passwordHash,
    capacityMw: String(Number(capacityMw)),
    emailVerified: true, // created out-of-band for dev/testing — no verification email needed
  });

  console.log(`Generator account created: id=${generator.id}, email=${email}, capacityMw=${capacityMw}`);
  console.log('Log in at /login (or POST /api/organizations/login) with this email/password.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('Failed to create generator:', err.message);
    process.exit(1);
  });
