import { readFileSync } from 'node:fs';
import { KNOWN_SCOPES } from './auth.mjs';

const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

function positiveInteger(value, fallback, label) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function booleanValue(value, fallback, label) {
  if (value === undefined || value === '') return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${label} must be true or false`);
}

function stringSet(value, fallback = '') {
  return new Set(
    (value ?? fallback)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function readSecret(env, directName, fileName) {
  if (env[fileName]) return readFileSync(env[fileName], 'utf8').trim();
  return env[directName]?.trim() ?? '';
}

function loadAgentCredentials(path) {
  if (!path) return [];
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`OPENCLI_AGENT_TOKENS_FILE must contain valid JSON: ${error.message}`);
  }
  if (!value || !Array.isArray(value.agents)) {
    throw new Error('OPENCLI_AGENT_TOKENS_FILE must contain an agents array');
  }
  const ids = new Set();
  const tokens = new Set();
  return value.agents.map((agent) => {
    if (!agent || !AGENT_ID_PATTERN.test(agent.id ?? '')) {
      throw new Error('each agent id must match /^[a-z0-9][a-z0-9-]{0,63}$/');
    }
    if (ids.has(agent.id)) throw new Error(`duplicate agent id: ${agent.id}`);
    if (typeof agent.token !== 'string' || agent.token.length < 24) {
      throw new Error(`agent ${agent.id} token must contain at least 24 characters`);
    }
    if (tokens.has(agent.token)) throw new Error('agent tokens must be unique');
    if (!Array.isArray(agent.scopes) || agent.scopes.length === 0) {
      throw new Error(`agent ${agent.id} must have at least one scope`);
    }
    const scopes = new Set(agent.scopes);
    for (const scope of scopes) {
      if (!KNOWN_SCOPES.has(scope) || scope === '*') {
        throw new Error(`agent ${agent.id} has unsupported scope: ${scope}`);
      }
    }
    ids.add(agent.id);
    tokens.add(agent.token);
    return { id: agent.id, token: agent.token, scopes };
  });
}

export function loadConfig(env = process.env) {
  const apiToken = readSecret(env, 'OPENCLI_API_TOKEN', 'OPENCLI_API_TOKEN_FILE');
  if (apiToken.length < 24) {
    throw new Error('OPENCLI_API_TOKEN or OPENCLI_API_TOKEN_FILE must contain at least 24 characters');
  }

  const allowedCommands = stringSet(env.OPENCLI_ALLOWED_COMMANDS);

  return {
    host: env.OPENCLI_API_HOST ?? '127.0.0.1',
    port: positiveInteger(env.OPENCLI_API_PORT, 8080, 'OPENCLI_API_PORT'),
    databasePath: env.OPENCLI_DATABASE_PATH ?? '/data/jobs.sqlite3',
    apiToken,
    agentCredentials: loadAgentCredentials(env.OPENCLI_AGENT_TOKENS_FILE),
    allowedCommands,
    autoAllowReads: booleanValue(
      env.OPENCLI_AUTO_ALLOW_READS,
      true,
      'OPENCLI_AUTO_ALLOW_READS',
    ),
    deniedArguments: stringSet(
      env.OPENCLI_DENIED_ARGUMENTS,
      'include-sensitive,token,password,secret,cookie',
    ),
    allowedOrigins: stringSet(env.OPENCLI_ALLOWED_ORIGINS),
    opencliBinary: env.OPENCLI_BINARY ?? 'opencli',
    maxConcurrency: positiveInteger(
      env.OPENCLI_MAX_CONCURRENCY,
      2,
      'OPENCLI_MAX_CONCURRENCY',
    ),
    maxQueuedJobs: positiveInteger(
      env.OPENCLI_MAX_QUEUED_JOBS,
      100,
      'OPENCLI_MAX_QUEUED_JOBS',
    ),
    maxSubmissionsPerMinute: positiveInteger(
      env.OPENCLI_MAX_SUBMISSIONS_PER_MINUTE,
      60,
      'OPENCLI_MAX_SUBMISSIONS_PER_MINUTE',
    ),
    defaultTimeoutSeconds: positiveInteger(
      env.OPENCLI_DEFAULT_TIMEOUT_SECONDS,
      120,
      'OPENCLI_DEFAULT_TIMEOUT_SECONDS',
    ),
    maxTimeoutSeconds: positiveInteger(
      env.OPENCLI_MAX_TIMEOUT_SECONDS,
      1800,
      'OPENCLI_MAX_TIMEOUT_SECONDS',
    ),
    maxWaitSeconds: positiveInteger(
      env.OPENCLI_MAX_WAIT_SECONDS,
      120,
      'OPENCLI_MAX_WAIT_SECONDS',
    ),
    watchdogGraceSeconds: positiveInteger(
      env.OPENCLI_WATCHDOG_GRACE_SECONDS,
      30,
      'OPENCLI_WATCHDOG_GRACE_SECONDS',
    ),
    sessionCheckSites: stringSet(env.OPENCLI_SESSION_CHECK_SITES),
    sessionCheckIntervalSeconds: positiveInteger(
      env.OPENCLI_SESSION_CHECK_INTERVAL_SECONDS,
      900,
      'OPENCLI_SESSION_CHECK_INTERVAL_SECONDS',
    ),
    maxOutputBytes: positiveInteger(
      env.OPENCLI_MAX_OUTPUT_BYTES,
      1_048_576,
      'OPENCLI_MAX_OUTPUT_BYTES',
    ),
  };
}
