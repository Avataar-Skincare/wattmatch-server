import pino from 'pino';

// Structured logging, replacing raw console.* calls throughout the auction module — JSON output by
// default so this can feed a real log-aggregation/SIEM system later (CERT-In's centralized-logging
// requirement expects exactly this shape), with human-readable pretty-printing only in local dev,
// controlled by NODE_ENV rather than a separate flag so it can't be left on by accident in prod.
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
});
