import { Router } from 'express';
import { readObject, isLocalStorageFallbackActive } from '../lib/s3.js';

const router = Router();

// Stands in for a real S3 signed-URL download ONLY when AWS_S3_BUCKET isn't configured (local dev/
// test) — see lib/s3.ts's getSignedDownloadUrl. Refuses to serve anything once a real bucket is
// configured, so this route is inert (always 404) in any environment that actually has S3 set up,
// production included, regardless of NODE_ENV.
router.get('/dev/local-storage/*', async (req, res) => {
  if (!isLocalStorageFallbackActive()) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  const key = (req.params as unknown as Record<string, string>)[0];
  const bytes = await readObject(key);
  if (!bytes) return res.status(404).json({ success: false, error: 'Not found' });
  res.setHeader('Content-Type', 'application/pdf');
  const filename = typeof req.query.filename === 'string' ? req.query.filename : undefined;
  if (filename) res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(bytes);
});

export default router;
