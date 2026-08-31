import type { Request, Response, NextFunction } from 'express';
import { VettingCustodianToken } from '../models/VettingCustodianToken.js';
import { VettingCustodian } from '../models/VettingCustodian.js';
import { hashOpaqueToken } from '../lib/passwordAuth.js';
import { extractBearerToken } from './auth.js';
import type { VettingEnvelope } from '../models/VettingOpeningAttestation.js';

// A custodian is not an Organization — deliberately not folded into middleware/auth.ts's org-role
// system, which is specifically about buyer/generator/admin accounts. A custodian's authority to act
// comes from holding a real key share plus this per-ceremony emailed link, not from any Wattmatch
// login. See VettingCustodian's own comment.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      custodian?: {
        id: number;
        name: string;
        tenderId: number;
        envelope: VettingEnvelope;
      };
    }
  }
}

export async function requireCustodianAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    res.status(401).json({ success: false, error: 'Missing or invalid ceremony link' });
    return;
  }

  const tokenHash = hashOpaqueToken(token);
  const record = await VettingCustodianToken.findOne({ where: { tokenHash } });
  if (!record || record.expiresAt.getTime() < Date.now()) {
    res.status(401).json({ success: false, error: 'This ceremony link is invalid or has expired' });
    return;
  }

  const custodian = await VettingCustodian.findByPk(record.custodianId);
  if (!custodian) {
    res.status(401).json({ success: false, error: 'This ceremony link is invalid or has expired' });
    return;
  }

  if (!record.usedAt) await record.update({ usedAt: new Date() });

  req.custodian = { id: custodian.id, name: custodian.name, tenderId: record.tenderId, envelope: record.envelope };
  next();
}
