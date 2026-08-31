import { mkdirSync, openSync, writeSync } from 'node:fs';
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

// Opened once at module load, not per call — appendFileSync(path, ...) opens and closes the file
// on every single invocation, which is a real cost on the hot path of every bid (accepted or
// rejected) under concurrent bidding, briefly blocking the whole event loop for the open/close
// syscalls on top of the write itself. A persistent fd with writeSync keeps the same synchronous,
// O_APPEND-based atomicity guarantee (see appendToLocalAuditLog's own comment) while paying only
// for the write, not a fresh open/close every time.
const fd = openSync(LOG_FILE, 'a');

interface LocalAuditRecord {
  auctionId: number;
  participantId: number;
  alias: string;
  amount: string;
  rate: string;
  returnPercent: string;
  accepted: boolean;
  rejectReason: string | null;
  ipHash: string | null;
  prevHash: string | null;
  hash: string;
  loggedAt: string;
}

// Sync + O_APPEND: small single-line writes stay atomic at the OS level even when multiple
// auctions' bids interleave concurrently — this needs no locking of its own, independent of
// whatever concurrency control the DB write happening right alongside it (appendAuditedBid) uses.
export function appendToLocalAuditLog(record: Omit<LocalAuditRecord, 'loggedAt'>) {
  const line = JSON.stringify({ ...record, loggedAt: new Date().toISOString() });
  writeSync(fd, line + '\n');
}
