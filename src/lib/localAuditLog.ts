import { appendFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Independent copy of the bid audit trail, deliberately NOT the same storage as the DB (see
// AuctionBidAudit) — the point is a second, differently-failing record: if the database were ever
// compromised, misconfigured, or rolled back, this file still has an untouched copy. A local disk
// file is a PoC-appropriate stand-in for what production should really be (e.g. a separate log
// shipped to something like CloudWatch/S3 with its own retention and access control) — see
// COMPLIANCE_CHECKLIST.md's "forensic readiness" item.
const LOG_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../logs');
const LOG_FILE = path.join(LOG_DIR, 'auction-audit.ndjson');

mkdirSync(LOG_DIR, { recursive: true });

interface LocalAuditRecord {
  auctionId: number;
  participantId: number;
  alias: string;
  amount: string;
  accepted: boolean;
  rejectReason: string | null;
  ipHash: string | null;
  prevHash: string | null;
  hash: string;
  loggedAt: string;
}

// Sync + O_APPEND: small single-line writes stay atomic at the OS level even when multiple
// auctions' bids interleave, so this needs no locking of its own beyond what appendAuditedBid's
// per-auction write lock already gives the DB write happening right alongside it.
export function appendToLocalAuditLog(record: Omit<LocalAuditRecord, 'loggedAt'>) {
  const line = JSON.stringify({ ...record, loggedAt: new Date().toISOString() });
  appendFileSync(LOG_FILE, line + '\n');
}
