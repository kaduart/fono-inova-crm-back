import { afterEach, describe, expect, it, vi } from 'vitest';
import { requireWebhookSecret, safeEqual, extractWebhookToken } from '../../middleware/webhookAuth.js';

const ENV = 'TEST_WEBHOOK_SECRET';

function response() {
  const res = { status: vi.fn(), json: vi.fn(), set: vi.fn(), setHeader: vi.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res;
}

function req({ params = {}, headers = {} } = {}) {
  return { params, headers, ip: '127.0.0.1', method: 'POST', originalUrl: '/hook' };
}

afterEach(() => {
  delete process.env[ENV];
  vi.restoreAllMocks();
});

describe('safeEqual', () => {
  it('compara strings em tempo constante', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual(null, 'abc')).toBe(false);
    expect(safeEqual('', '')).toBe(false);
  });
});

describe('extractWebhookToken', () => {
  it('prioriza :token, depois x-webhook-secret, depois Bearer', () => {
    expect(extractWebhookToken(req({ params: { token: 'p' }, headers: { 'x-webhook-secret': 'h' } }))).toBe('p');
    expect(extractWebhookToken(req({ headers: { 'x-webhook-secret': 'h', authorization: 'Bearer b' } }))).toBe('h');
    expect(extractWebhookToken(req({ headers: { authorization: 'Bearer b' } }))).toBe('b');
    expect(extractWebhookToken(req())).toBe(null);
  });
});

describe('requireWebhookSecret', () => {
  it('fail-closed: sem env configurada responde 503', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = response();
    const next = vi.fn();
    await requireWebhookSecret(ENV)(req(), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('allowWhenUnset: sem env deixa passar (legado)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const next = vi.fn();
    requireWebhookSecret(ENV, { allowWhenUnset: true })(req(), response(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('com env: recusa segredo ausente ou errado com 401', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env[ENV] = 's3cr3t';
    for (const r of [req(), req({ headers: { 'x-webhook-secret': 'errado' } })]) {
      const res = response();
      const next = vi.fn();
      await requireWebhookSecret(ENV, { allowWhenUnset: true })(r, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(401);
    }
  });

  it('com env: aceita segredo correto por header ou path', () => {
    process.env[ENV] = 's3cr3t';
    for (const r of [req({ headers: { 'x-webhook-secret': 's3cr3t' } }), req({ params: { token: 's3cr3t' } })]) {
      const next = vi.fn();
      requireWebhookSecret(ENV)(r, response(), next);
      expect(next).toHaveBeenCalledOnce();
    }
  });
});
