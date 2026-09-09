import { describe, expect, it } from 'vitest';
import { redactHeaders, redactUrl, redactValue } from './redaction.js';

describe('observation redaction', () => {
  it('redacts sensitive headers by default', () => {
    expect(redactHeaders({
      authorization: 'Bearer secret-token',
      cookie: 'sid=abc',
      'set-cookie': 'sid=abc',
      accept: 'application/json',
    })).toEqual({
      authorization: '[REDACTED]',
      cookie: '[REDACTED]',
      'set-cookie': '[REDACTED]',
      accept: 'application/json',
    });
  });

  it('redacts sensitive url query params', () => {
    expect(redactUrl('https://x.test/api?token=abc&ok=1&password=secret'))
      .toBe('https://x.test/api?token=[REDACTED]&ok=1&password=[REDACTED]');
  });

  it('redacts Xiaohongshu signed URL tokens', () => {
    expect(redactUrl('https://www.xiaohongshu.com/explore/abc?xsec_token=private-value&xsec_source=pc_search'))
      .toBe('https://www.xiaohongshu.com/explore/abc?xsec_token=[REDACTED]&xsec_source=pc_search');
  });

  it('redacts password and token fields recursively', () => {
    expect(redactValue({
      user: 'alice',
      password: 'secret',
      nested: { access_token: 'abc123456789', value: 'safe' },
    })).toEqual({
      user: 'alice',
      password: '[REDACTED]',
      nested: { access_token: '[REDACTED]', value: 'safe' },
    });
  });
});
