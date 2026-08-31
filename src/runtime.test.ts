import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserBridge, CDPBridge } from './browser/index.js';
import type { IPage } from './types.js';
import { browserSession, getBrowserFactory, type IBrowserFactory } from './runtime.js';

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

describe('getBrowserFactory', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('uses BrowserBridge for regular sites by default', () => {
    expect(getBrowserFactory('xianyu')).toBe(BrowserBridge);
  });

  it('uses CDPBridge when OPENCLI_CDP_ENDPOINT is configured', () => {
    vi.stubEnv('OPENCLI_CDP_ENDPOINT', 'http://127.0.0.1:9333');

    expect(getBrowserFactory('xianyu')).toBe(CDPBridge);
  });
});
