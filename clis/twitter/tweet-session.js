import { createHash } from 'node:crypto';
import { AuthRequiredError } from '@jackwener/opencli/errors';
export function sessionScope(cookies) {
    const token = cookies.find(c => c.name === 'auth_token')?.value;
    const csrf = cookies.find(c => c.name === 'ct0')?.value;
    if (!token || !csrf) throw new AuthRequiredError('x.com', 'X login required');
    // A non-replayable identifier, never the cookie itself. Rotation invalidates caches.
    return createHash('sha256').update('opencli-x-cache-v1\0' + token).digest('hex');
}
