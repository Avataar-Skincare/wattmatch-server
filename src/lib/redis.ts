import { Redis } from 'ioredis';
import { logger } from './logger.js';

export const redis = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
});

// Structured logging (Pino), not console — this is the single most critical dependency the
// auction module has (every bid, state read, and rate limit goes through it), so its connection
// events belong in the same structured/JSON log stream as everything else, not a plain console
// line that production log tooling won't parse or alert on the same way.
redis.on('error', (err: Error) => logger.error({ err }, '[REDIS] connection error'));
redis.on('connect', () => logger.info('[REDIS] connected'));
