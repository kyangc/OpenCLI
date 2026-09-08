import { beforeEach, describe, expect, it, vi } from 'vitest';

const { MockWebSocket } = vi.hoisted(() => {
  class MockWebSocket {
    static OPEN = 1;
    static lastInstance: MockWebSocket | undefined;
    readyState = 1;
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

    constructor(_url: string) {
      MockWebSocket.lastInstance = this;
      queueMicrotask(() => this.emit('open'));
    }

    on(event: string, handler: (...args: unknown[]) => void): void {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
    }

    send(_message: string): void {}

    close(): void {
      this.readyState = 3;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const handler of this.handlers.get(event) ?? []) {
        handler(...args);
      }
    }
  }

  return { MockWebSocket };
});

vi.mock('ws', () => ({
  WebSocket: MockWebSocket,
}));

import { CDPBridge, CDP_REQUEST_BODY_CAPTURE_LIMIT } from './cdp.js';

function emitCdpEvent(method: string, params: Record<string, unknown>): void {
  MockWebSocket.lastInstance?.emit('message', Buffer.from(JSON.stringify({ method, params })));
}

async function flushAsyncCaptureWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('CDPBridge cookies', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('filters cookies by actual domain match instead of substring match', async () => {
    vi.stubEnv('OPENCLI_CDP_ENDPOINT', 'ws://127.0.0.1:9222/devtools/page/1');

    const bridge = new CDPBridge();
    vi.spyOn(bridge, 'send').mockResolvedValue({
      cookies: [
        { name: 'good', value: '1', domain: '.example.com' },
        { name: 'exact', value: '2', domain: 'example.com' },
        { name: 'bad', value: '3', domain: 'notexample.com' },
      ],
    });

    const page = await bridge.connect();
    const cookies = await page.getCookies({ domain: 'example.com' });

    expect(cookies).toEqual([
      { name: 'good', value: '1', domain: '.example.com' },
      { name: 'exact', value: '2', domain: 'example.com' },
    ]);
  });

  it('exposes native input helpers on direct CDP pages', async () => {
    vi.stubEnv('OPENCLI_CDP_ENDPOINT', 'ws://127.0.0.1:9222/devtools/page/1');

    const bridge = new CDPBridge();
    const send = vi.spyOn(bridge, 'send').mockResolvedValue({});

    const page = await bridge.connect();
    send.mockClear();

    expect(page.nativeType).toBeTypeOf('function');
    expect(page.nativeKeyPress).toBeTypeOf('function');
    expect(page.nativeClick).toBeTypeOf('function');
    expect(page.handleJavaScriptDialog).toBeTypeOf('function');
    expect(page.cdp).toBeTypeOf('function');

    await page.nativeType!('hello');
    await page.nativeKeyPress!('a', ['Ctrl']);
    await page.nativeClick!(10, 20);
    await page.handleJavaScriptDialog!(true, 'ok');
    await page.cdp!('Page.getLayoutMetrics', {});

    expect(send.mock.calls).toEqual([
      ['Input.insertText', { text: 'hello' }],
      ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', modifiers: 2 }],
      ['Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', modifiers: 2 }],
      ['Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 20 }],
      ['Input.dispatchMouseEvent', { type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 }],
      ['Input.dispatchMouseEvent', { type: 'mouseReleased', x: 10, y: 20, button: 'left', clickCount: 1 }],
      ['Page.handleJavaScriptDialog', { accept: true, promptText: 'ok' }],
      ['Page.getLayoutMetrics', {}],
    ]);
  });

  it('captures request headers and bounded post data on direct CDP pages', async () => {
    vi.stubEnv('OPENCLI_CDP_ENDPOINT', 'ws://127.0.0.1:9222/devtools/page/1');

    const bridge = new CDPBridge();
    const fullBody = 'x'.repeat(CDP_REQUEST_BODY_CAPTURE_LIMIT + 5);
    vi.spyOn(bridge, 'send').mockImplementation(async (method: string) => {
      if (method === 'Network.getRequestPostData') return { postData: fullBody };
      return {};
    });

    const page = await bridge.connect();
    await page.startNetworkCapture?.();
    emitCdpEvent('Network.requestWillBeSent', {
      requestId: 'request-1',
      request: {
        method: 'POST',
        url: 'https://example.test/rsc-action/actions/pagination',
        headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
        hasPostData: true,
      },
    });
    emitCdpEvent('Network.loadingFinished', { requestId: 'request-1' });
    await flushAsyncCaptureWork();

    const entries = await page.readNetworkCapture?.() as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      method: 'POST',
      requestHeaders: { Authorization: 'Bearer secret', 'Content-Type': 'application/json' },
      requestBodyKind: 'string',
      requestBodyFullSize: fullBody.length,
      requestBodyTruncated: true,
    });
    expect(String(entries[0].requestBodyPreview)).toHaveLength(CDP_REQUEST_BODY_CAPTURE_LIMIT);
  });

  it('keeps an in-flight request across an early read and returns it exactly once after completion', async () => {
    vi.stubEnv('OPENCLI_CDP_ENDPOINT', 'ws://127.0.0.1:9222/devtools/page/1');

    const bridge = new CDPBridge();
    vi.spyOn(bridge, 'send').mockImplementation(async (method: string) => {
      if (method === 'Network.getResponseBody') return { body: '{"ok":true}', base64Encoded: false };
      return {};
    });

    const page = await bridge.connect();
    await page.startNetworkCapture?.();
    emitCdpEvent('Network.requestWillBeSent', {
      requestId: 'request-early-read',
      request: { method: 'GET', url: 'https://example.test/api/data' },
    });

    await expect(page.readNetworkCapture?.()).resolves.toEqual([]);

    emitCdpEvent('Network.responseReceived', {
      requestId: 'request-early-read',
      response: { status: 200, mimeType: 'application/json' },
    });
    emitCdpEvent('Network.loadingFinished', { requestId: 'request-early-read' });
    await flushAsyncCaptureWork();

    await expect(page.readNetworkCapture?.()).resolves.toEqual([
      expect.objectContaining({
        url: 'https://example.test/api/data',
        method: 'GET',
        responseStatus: 200,
        responseContentType: 'application/json',
        responsePreview: '{"ok":true}',
      }),
    ]);
    await expect(page.readNetworkCapture?.()).resolves.toEqual([]);
  });

  it('keeps request identity stable when a later request completes first', async () => {
    vi.stubEnv('OPENCLI_CDP_ENDPOINT', 'ws://127.0.0.1:9222/devtools/page/1');

    const bridge = new CDPBridge();
    vi.spyOn(bridge, 'send').mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Network.getResponseBody') return { body: `body-${params?.requestId}`, base64Encoded: false };
      return {};
    });

    const page = await bridge.connect();
    await page.startNetworkCapture?.();
    emitCdpEvent('Network.requestWillBeSent', {
      requestId: 'request-a',
      request: { method: 'GET', url: 'https://example.test/api/a' },
    });
    await expect(page.readNetworkCapture?.()).resolves.toEqual([]);
    emitCdpEvent('Network.requestWillBeSent', {
      requestId: 'request-b',
      request: { method: 'POST', url: 'https://example.test/api/b' },
    });

    emitCdpEvent('Network.responseReceived', {
      requestId: 'request-b',
      response: { status: 201, mimeType: 'application/json' },
    });
    emitCdpEvent('Network.loadingFinished', { requestId: 'request-b' });
    await flushAsyncCaptureWork();
    await expect(page.readNetworkCapture?.()).resolves.toEqual([
      expect.objectContaining({
        url: 'https://example.test/api/b',
        method: 'POST',
        responseStatus: 201,
        responsePreview: 'body-request-b',
      }),
    ]);

    emitCdpEvent('Network.responseReceived', {
      requestId: 'request-a',
      response: { status: 200, mimeType: 'text/plain' },
    });
    emitCdpEvent('Network.loadingFinished', { requestId: 'request-a' });
    await flushAsyncCaptureWork();
    await expect(page.readNetworkCapture?.()).resolves.toEqual([
      expect.objectContaining({
        url: 'https://example.test/api/a',
        method: 'GET',
        responseStatus: 200,
        responsePreview: 'body-request-a',
      }),
    ]);
    await expect(page.readNetworkCapture?.()).resolves.toEqual([]);
  });

  it('does not drain or block on a pending body fetch while newer requests complete', async () => {
    vi.stubEnv('OPENCLI_CDP_ENDPOINT', 'ws://127.0.0.1:9222/devtools/page/1');

    let resolveBodyA!: (value: { body: string; base64Encoded: boolean }) => void;
    const bodyA = new Promise<{ body: string; base64Encoded: boolean }>((resolve) => {
      resolveBodyA = resolve;
    });
    const bridge = new CDPBridge();
    vi.spyOn(bridge, 'send').mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Network.getResponseBody' && params?.requestId === 'request-a') return bodyA;
      if (method === 'Network.getResponseBody') return { body: 'body-b', base64Encoded: false };
      return {};
    });

    const page = await bridge.connect();
    await page.startNetworkCapture?.();
    emitCdpEvent('Network.requestWillBeSent', {
      requestId: 'request-a',
      request: { method: 'GET', url: 'https://example.test/api/a' },
    });
    emitCdpEvent('Network.loadingFinished', { requestId: 'request-a' });

    await expect(page.readNetworkCapture?.()).resolves.toEqual([]);

    emitCdpEvent('Network.requestWillBeSent', {
      requestId: 'request-b',
      request: { method: 'GET', url: 'https://example.test/api/b' },
    });
    emitCdpEvent('Network.loadingFinished', { requestId: 'request-b' });
    await flushAsyncCaptureWork();
    await expect(page.readNetworkCapture?.()).resolves.toEqual([
      expect.objectContaining({ url: 'https://example.test/api/b', responsePreview: 'body-b' }),
    ]);

    resolveBodyA({ body: 'body-a', base64Encoded: false });
    await flushAsyncCaptureWork();
    await expect(page.readNetworkCapture?.()).resolves.toEqual([
      expect.objectContaining({ url: 'https://example.test/api/a', responsePreview: 'body-a' }),
    ]);
    await expect(page.readNetworkCapture?.()).resolves.toEqual([]);
  });

  it('finalizes failed loads and failed body fetches with explicit missing-body metadata', async () => {
    vi.stubEnv('OPENCLI_CDP_ENDPOINT', 'ws://127.0.0.1:9222/devtools/page/1');

    const bridge = new CDPBridge();
    vi.spyOn(bridge, 'send').mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Network.getResponseBody' && params?.requestId === 'body-failed') {
        throw new Error('No resource with given identifier found');
      }
      return {};
    });

    const page = await bridge.connect();
    await page.startNetworkCapture?.();
    emitCdpEvent('Network.requestWillBeSent', {
      requestId: 'load-failed',
      request: { method: 'GET', url: 'https://example.test/api/load-failed' },
    });
    emitCdpEvent('Network.loadingFailed', {
      requestId: 'load-failed',
      errorText: 'net::ERR_ABORTED',
    });
    emitCdpEvent('Network.requestWillBeSent', {
      requestId: 'body-failed',
      request: { method: 'GET', url: 'https://example.test/api/body-failed' },
    });
    emitCdpEvent('Network.responseReceived', {
      requestId: 'body-failed',
      response: { status: 204, mimeType: 'application/json' },
    });
    emitCdpEvent('Network.loadingFinished', { requestId: 'body-failed' });
    await flushAsyncCaptureWork();

    await expect(page.readNetworkCapture?.()).resolves.toEqual([
      expect.objectContaining({
        url: 'https://example.test/api/load-failed',
        responseBodyMissing: true,
        responseBodyError: 'net::ERR_ABORTED',
      }),
      expect.objectContaining({
        url: 'https://example.test/api/body-failed',
        responseStatus: 204,
        responseBodyMissing: true,
        responseBodyError: 'No resource with given identifier found',
      }),
    ]);
    await expect(page.readNetworkCapture?.()).resolves.toEqual([]);
  });

  it('starts a fresh capture window without reinstalling listeners', async () => {
    vi.stubEnv('OPENCLI_CDP_ENDPOINT', 'ws://127.0.0.1:9222/devtools/page/1');

    let resolveStaleBody!: (value: { body: string; base64Encoded: boolean }) => void;
    const staleBody = new Promise<{ body: string; base64Encoded: boolean }>((resolve) => {
      resolveStaleBody = resolve;
    });
    const bridge = new CDPBridge();
    const send = vi.spyOn(bridge, 'send').mockImplementation(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Network.getResponseBody' && params?.requestId === 'stale') return staleBody;
      if (method === 'Network.getResponseBody') return { body: `body-${params?.requestId}`, base64Encoded: false };
      return {};
    });

    const page = await bridge.connect();
    await page.startNetworkCapture?.();
    emitCdpEvent('Network.requestWillBeSent', {
      requestId: 'stale',
      request: { method: 'GET', url: 'https://example.test/api/stale' },
    });
    emitCdpEvent('Network.loadingFinished', { requestId: 'stale' });

    await page.startNetworkCapture?.();
    await expect(page.readNetworkCapture?.()).resolves.toEqual([]);
    emitCdpEvent('Network.requestWillBeSent', {
      requestId: 'fresh',
      request: { method: 'GET', url: 'https://example.test/api/fresh' },
    });
    emitCdpEvent('Network.responseReceived', {
      requestId: 'fresh',
      response: { status: 200, mimeType: 'application/json' },
    });
    emitCdpEvent('Network.loadingFinished', { requestId: 'fresh' });
    await flushAsyncCaptureWork();
    resolveStaleBody({ body: 'stale-body', base64Encoded: false });
    await flushAsyncCaptureWork();

    await expect(page.readNetworkCapture?.()).resolves.toEqual([
      expect.objectContaining({ url: 'https://example.test/api/fresh', responseStatus: 200 }),
    ]);
    expect(send.mock.calls.filter(([method]) => method === 'Network.enable')).toHaveLength(1);
  });

  it('reuses a request record across redirects and preserves the initial POST body', async () => {
    vi.stubEnv('OPENCLI_CDP_ENDPOINT', 'ws://127.0.0.1:9222/devtools/page/1');

    const bridge = new CDPBridge();
    vi.spyOn(bridge, 'send').mockImplementation(async (method: string) => {
      if (method === 'Network.getResponseBody') return { body: '{"redirected":true}', base64Encoded: false };
      return {};
    });

    const page = await bridge.connect();
    await page.startNetworkCapture?.();
    emitCdpEvent('Network.requestWillBeSent', {
      requestId: 'redirected-request',
      request: {
        method: 'POST',
        url: 'https://example.test/login',
        postData: 'user=a&pass=b',
        hasPostData: true,
      },
    });
    emitCdpEvent('Network.requestWillBeSent', {
      requestId: 'redirected-request',
      redirectResponse: { status: 302, url: 'https://example.test/login' },
      request: {
        method: 'GET',
        url: 'https://example.test/home',
      },
    });

    await expect(page.readNetworkCapture?.()).resolves.toEqual([]);

    emitCdpEvent('Network.responseReceived', {
      requestId: 'redirected-request',
      response: { status: 200, mimeType: 'application/json' },
    });
    emitCdpEvent('Network.loadingFinished', { requestId: 'redirected-request' });
    await flushAsyncCaptureWork();

    await expect(page.readNetworkCapture?.()).resolves.toEqual([
      expect.objectContaining({
        url: 'https://example.test/login',
        method: 'POST',
        requestBodyKind: 'string',
        requestBodyPreview: 'user=a&pass=b',
        responseStatus: 200,
        responsePreview: '{"redirected":true}',
      }),
    ]);
    await expect(page.readNetworkCapture?.()).resolves.toEqual([]);
  });
});
