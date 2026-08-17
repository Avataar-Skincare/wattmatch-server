// Demo utility — seeds a reverse-auction and prints ready-to-share join links.
// There's no admin UI yet (see AUCTION_MVP_PLAN.md), so this replaces typing a raw curl command
// live in front of an audience. Edit the config below before each demo, then run:
//   node scripts/seed-demo-auction.mjs                        (talks to localhost:4000)
//   node scripts/seed-demo-auction.mjs http://192.168.5.18:4000  (talks to a LAN-hosted server —
//   pass the backend's current LAN IP; it changes between networks/sessions, so re-check it with
//   `ipconfig`/`Get-NetIPAddress` before each demo rather than assuming this one still applies)

const apiBase = process.argv[2] || 'http://localhost:4000';

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
    headers: { 'Content-Type': 'application/json' },
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

  console.log(`Check status / pull the result later:\n  ${apiBase}/api/auction-admin/auctions/${result.auctionId}/export`);
}

main().catch((err) => {
  console.error('Could not reach the server — is it running, and is the API base URL correct?', err.message);
  process.exit(1);
});
