import { describe, expect, it, vi } from 'vitest';

const { ensureReadyMock, sendCommandMock } = vi.hoisted(() => ({
  ensureReadyMock: vi.fn().mockResolvedValue(undefined),
  sendCommandMock: vi.fn().mockResolvedValue(42),
}));

vi.mock('./daemon-lifecycle.js', () => ({
  ensureBrowserBridgeReady: ensureReadyMock,
}));

vi.mock('./daemon-client.js', () => ({
  sendCommand: sendCommandMock,
  sendCommandFull: vi.fn(),
}));

import { BrowserBridge } from './bridge.js';

describe('BrowserBridge', () => {
  it('binds command access to the connected page', async () => {
    const browser = new BrowserBridge();
    const page = await browser.connect({
      session: 'site:twitter',
      contextId: 'profile-test',
      surface: 'adapter',
      access: 'read',
    });

    await page.evaluate('21 + 21');

    expect(sendCommandMock).toHaveBeenCalledWith('exec', expect.objectContaining({
      session: 'site:twitter',
      access: 'read',
    }));
  });
});
