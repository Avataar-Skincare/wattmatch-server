import type { Request, Response, NextFunction } from 'express';
import { RateLimiterRedis } from 'rate-limiter-flexible';
import { redis } from './redis.js';

export interface JsonRateLimitOptions {
  // A stable, globally unique identifier for THIS limiter — e.g. 'organizations:login'. Required
  // because the underlying counter lives in Redis, shared across every server instance and every
  // process that imports this module; two different limiters accidentally reusing the same name
  // would silently share one one call budget instead of each enforcing its own.
  name: string;
  windowMs: number;
  limit: number;
  message?: { success: false; error: string };
}

// Redis-backed (via rate-limiter-flexible's RateLimiterRedis — already a dependency, used the same
// way by auctionSocket.ts's bid limiters), not express-rate-limit's in-memory MemoryStore. Every
// limiter in this app used to keep its own per-process counter: correct on one server instance, but
// silently wrong the moment there's more than one behind a load balancer, since each instance never
// sees another instance's hits — the effective limit becomes limit × instance count. Backed by
// Redis, which every deployment of this app already depends on for the auction engine and OTP flow,
// the same counter is shared and the limit is correct no matter how many instances are running.
export function jsonRateLimit(options: JsonRateLimitOptions) {
  const limiter = new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: `ratelimit:${options.name}`,
    points: options.limit,
    duration: Math.max(1, Math.ceil(options.windowMs / 1000)),
  });
  const message = options.message ?? { success: false, error: 'Too many requests — try again shortly.' };

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction) {
    limiter
      .consume(req.ip ?? 'unknown')
      .then(() => next())
      .catch((err: unknown) => {
        // `.consume()` rejects with a RateLimiterRes when the caller is over the limit — that's the
        // expected "blocked" outcome. A real failure (Redis unreachable) rejects with an actual
        // Error and must propagate as the failure it is, not be silently treated as "rate limited"
        // (same distinction auctionSocket.ts's own isRateLimited draws for the identical library).
        if (err instanceof Error) return next(err);
        res.status(429).json(message);
      });
  };
}
