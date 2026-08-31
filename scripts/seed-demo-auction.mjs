// Demo utility — seeds a reverse-auction and prints ready-to-share join links.
// There's no admin UI yet (see AUCTION_MVP_PLAN.md), so this replaces typing a raw curl command
// live in front of an audience. Edit the config below before each demo, then run:
//   ADMIN_TOKEN=<token> node scripts/seed-demo-auction.mjs                        (localhost:4000)
//   ADMIN_TOKEN=<token> node scripts/seed-demo-auction.mjs http://192.168.5.18:4000  (a LAN-hosted
//   server — pass the backend's current LAN IP; it changes between networks/sessions, so re-check it
//   with `ipconfig`/`Get-NetIPAddress` before each demo rather than assuming this one still applies)
//
// /auctions/seed is admin-only (middleware/auth.ts) — get ADMIN_TOKEN by logging in as an admin
// account (POST /api/organizations/login, created via scripts/create-admin.mjs if none exists yet)
// and copying the `token` field from the response.

const apiBase = process.argv[2] || 'http://localhost:4000';
const adminToken = process.env.ADMIN_TOKEN;

if (!adminToken) {
  console.error('Set ADMIN_TOKEN first — /auctions/seed is admin-only. Log in as an admin (POST /api/organizations/login) and pass its token:');
  console.error('  ADMIN_TOKEN=<token> node scripts/seed-demo-auction.mjs');
  process.exit(1);
}

// --- Edit this block for the actual demo ---
const config = {
  title: 'WattMatch live demo',
  openingBid: 6.5,
  // 8 matches the real platform default (auctionAdmin.ts's seedBodySchema) — the countdown
  // resets on every accepted bid, up to this many times, which is the actual anti-sniping
  // requirement (AUCTION_PLAN.md's soft-close behavior). Demoing the real behavior, not a
  // demo-only override, per explicit instruction — a bid landing late WILL reset the clock, on
  // purpose, up to 8 times per auction.
  windowSeconds: 300,
  maxAutoExtensions: 8,
  // Landed-rate formula inputs (see auctionEngine.ts's computeLandedRate) — only required when
  // useLandedRate is true below. Set useLandedRate: false to demo the original single-rate auction
  // instead, and drop these two lines entirely.
  useLandedRate: true,
  equityValue: 1000000,
  totalUnitsPerYear: 500000,
  participants: [
    { organizationName: 'Demo Generator One', alias: 'GEN-1' },
    { organizationName: 'Demo Generator Two', alias: 'GEN-2' },
    { organizationName: 'Demo Generator Three', alias: 'GEN-3' },
    { organizationName: 'Demo Generator Four', alias: 'GEN-4' },
    { organizationName: 'Demo Generator Five', alias: 'GEN-5' },
  ],
  // Optional — omit this key entirely if you don't want a spectator/buyer link for this demo.
  buyer: { organizationName: 'Demo Buyer', alias: 'BUYER' },
};
// --- end editable block ---

async function main() {
  const res = await fetch(`${apiBase}/api/auction-admin/auctions/seed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify(config),
  });
  const result = await res.json();

  if (!result.success) {
    console.error('Seed failed:', result.error);
    process.exit(1);
  }

  console.log(`\nAuction #${result.auctionId} seeded: "${config.title}"`);
  console.log(`Window: ${config.windowSeconds}s, opening bid ₹${config.openingBid}\n`);

  console.log('Generator links:');
  for (const link of result.links) {
    console.log(`  ${link.alias} (${link.organizationName}):\n    ${link.joinUrl}\n`);
  }

  if (result.buyerLink) {
    console.log('Buyer (spectator) link:');
    console.log(`  ${result.buyerLink.alias} (${result.buyerLink.organizationName}):\n    ${result.buyerLink.joinUrl}\n`);
  }

  console.log(`Check status / pull the result later (admin token required):\n  ${apiBase}/api/auction-admin/auctions/${result.auctionId}/export`);
}

main().catch((err) => {
  console.error('Could not reach the server — is it running, and is the API base URL correct?', err.message);
  process.exit(1);
});
