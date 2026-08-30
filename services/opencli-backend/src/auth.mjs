import { timingSafeEqual } from 'node:crypto';

export const KNOWN_SCOPES = new Set([
  '*',
  'commands:read',
  'jobs:submit',
  'jobs:read',
  'jobs:cancel',
  'sessions:read',
  'control:write',
  'metrics:read',
  'audit:read',
]);

function safeTokenEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && timingSafeEqual(actualBuffer, expectedBuffer);
}

export function hasScope(principal, scope) {
  return principal?.scopes?.has('*') || principal?.scopes?.has(scope) || false;
}

export function createAuthenticator(config) {
  const credentials = [
    { id: 'admin', token: config.apiToken, scopes: new Set(['*']) },
    ...(config.agentCredentials ?? []),
  ];
  return (authorization) => {
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) return null;
    const token = authorization.slice(7);
    const credential = credentials.find((candidate) => safeTokenEqual(token, candidate.token));
    if (!credential) return null;
    return {
      id: credential.id,
      scopes: new Set(credential.scopes),
      isAdmin: credential.scopes.has('*'),
    };
  };
}
