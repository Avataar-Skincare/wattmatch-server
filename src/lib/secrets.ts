import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { logger } from './logger.js';

// A single abstraction for "where does this secret actually come from", so the rest of the app
// never has to know whether it's talking to AWS Secrets Manager or a plain env var. Local dev needs
// zero AWS setup at all — it's the exact same env-var behavior as before this file existed. In
// production, the same call transparently fetches from Secrets Manager instead, fetched once and
// cached for the process's lifetime: none of this project's current secrets need in-place rotation
// without a restart yet, so fetch-once is the right first step, not a corner cut.
const cache = new Map<string, string>();

// Tracks fetches currently in flight, keyed the same as `cache` — without this, a burst of calls
// for the same not-yet-cached secret (e.g. every socket connecting at once right after a cold
// start, each independently calling verifyJoinToken -> getJwtSecret) would each kick off their own
// AWS Secrets Manager request before the first one resolves and populates `cache`. Harmless
// correctness-wise (every fetch returns the same value), but a needless multiplication of AWS API
// calls at exactly the moment — a cold-start burst of connections — that this is most likely to
// happen. Cleared once the fetch settles either way, so a failed fetch doesn't wedge subsequent
// calls behind a promise that's already rejected.
const inFlight = new Map<string, Promise<string | undefined>>();

// Constructed lazily, not at module load — creating this in a local-dev process with no AWS
// credentials configured at all would be pointless work and a needless dependency on AWS reachability
// for something that's about to just read an env var anyway.
let client: SecretsManagerClient | null = null;
function getClient(): SecretsManagerClient {
  if (!client) client = new SecretsManagerClient({});
  return client;
}

// `awsSecretId` is optional and separate from `envVarName` on purpose — the env var is always the
// local-dev/fallback name (e.g. AUCTION_JWT_SECRET), while the AWS secret id is a full ARN or name
// configured only in production, via its own env var (e.g. AUCTION_JWT_SECRET_ARN). No ARN
// configured means this simply behaves exactly as it did before Secrets Manager was wired in.
export async function loadSecret(envVarName: string, awsSecretIdEnvVar: string): Promise<string | undefined> {
  if (cache.has(envVarName)) return cache.get(envVarName);

  const existing = inFlight.get(envVarName);
  if (existing) return existing;

  const fetchPromise = fetchSecret(envVarName, awsSecretIdEnvVar).finally(() => inFlight.delete(envVarName));
  inFlight.set(envVarName, fetchPromise);
  return fetchPromise;
}

async function fetchSecret(envVarName: string, awsSecretIdEnvVar: string): Promise<string | undefined> {
  const awsSecretId = process.env[awsSecretIdEnvVar];
  if (process.env.NODE_ENV === 'production' && awsSecretId) {
    try {
      const result = await getClient().send(new GetSecretValueCommand({ SecretId: awsSecretId }));
      if (result.SecretString) {
        cache.set(envVarName, result.SecretString);
        return result.SecretString;
      }
    } catch (err) {
      // Falls through to the env var below rather than throwing — a Secrets Manager outage
      // shouldn't be able to take the whole server down if a (less ideal, but working) env var
      // fallback is still configured. If neither is set, callers get undefined either way and can
      // decide how to handle a genuinely missing secret themselves.
      logger.error({ err, awsSecretId }, '[SECRETS] failed to fetch from AWS Secrets Manager, falling back to env var');
    }
  }

  const envValue = process.env[envVarName];
  if (envValue) cache.set(envVarName, envValue);
  return envValue;
}
