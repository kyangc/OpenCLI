import { describe, expect, it } from 'vitest';

import type { IPage } from './types.js';
import { browserSession, type IBrowserFactory } from './runtime.js';

describe('browserSession', () => {
  it('forwards command access to the browser factory', async () => {
    let received: Parameters<IBrowserFactory['connect']>[0];

    class TestBrowserFactory implements IBrowserFactory {
      async connect(opts?: Parameters<IBrowserFactory['connect']>[0]): Promise<IPage> {
        received = opts;
        return {} as IPage;
      }

      async close(): Promise<void> {}
    }

    await browserSession(TestBrowserFactory, async () => undefined, { access: 'read' });

    expect(received?.access).toBe('read');
  });
});
