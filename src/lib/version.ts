import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };

// DEPLOY_VERSION lets a real CI pipeline stamp the actual deployed commit/build (e.g. a short git
// SHA) — falls back to package.json's version for local/dev runs where no such pipeline exists.
// Recorded on every result summary (see auctionEngine.ts) so a forensic review of a past auction
// can tell exactly which code produced it — see COMPLIANCE_CHECKLIST.md's "forensic readiness" item.
export const DEPLOYED_CODE_VERSION = process.env.DEPLOY_VERSION || pkg.version;
