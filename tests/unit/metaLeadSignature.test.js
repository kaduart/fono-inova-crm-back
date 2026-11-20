/**
 * Assinatura das notificações (POST) de leads da Meta: X-Hub-Signature-256 = sha256=HMAC(App Secret, corpo cru).
 * Segredo e corpo fictícios.
 */
import crypto from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import { verifyMetaSignature, metaSignaturePolicy, checkMetaNotification, metaNotificationGuard } from '../../utils/metaWebhookVerify.js';

const SECRET = 'segredo-ficticio-de-teste';
const body = Buffer.from(JSON.stringify({ entry: [{ changes: [{ value: { leadgen_id: 'L1', field_data: [] } }] }] }));
const sign = (buf, key = SECRET) => `sha256=${crypto.createHmac('sha256', key).update(buf).digest('hex')}`;

describe('verifyMetaSignature', () => {
  it('aceita a assinatura certa do corpo cru', () => {
    expect(verifyMetaSignature(body, sign(body), SECRET)).toEqual({ ok: true });
    expect(verifyMetaSignature(body, sign(body).toUpperCase().replace('SHA256', 'sha256'), SECRET).ok).toBe(true);
  });
  it('recusa corpo alterado, outro segredo, sem cabeçalho, mal formado e sem segredo', () => {
    const changed = Buffer.from(body.toString().replace('L1', 'L2'));
    expect(verifyMetaSignature(changed, sign(body), SECRET).reason).toBe('assinatura_invalida');
    expect(verifyMetaSignature(body, sign(body, 'outro'), SECRET).reason).toBe('assinatura_invalida');
    expect(verifyMetaSignature(body, undefined, SECRET).reason).toBe('sem_assinatura');
    expect(verifyMetaSignature(body, 'sha1=abc', SECRET).reason).toBe('assinatura_mal_formada');
    expect(verifyMetaSignature(body, sign(body), '').reason).toBe('app_secret_nao_configurado');
  });
});

describe('política META_LEAD_SIGNATURE', () => {
  it('padrão log; aceita off/log/on; desconhecido vira log', () => {
    expect(metaSignaturePolicy({})).toBe('log');
    expect(metaSignaturePolicy({ META_LEAD_SIGNATURE: 'ON' })).toBe('on');
    expect(metaSignaturePolicy({ META_LEAD_SIGNATURE: 'off' })).toBe('off');
    expect(metaSignaturePolicy({ META_LEAD_SIGNATURE: 'talvez' })).toBe('log');
  });
  it('on recusa sem assinatura válida, inclusive sem segredo (falha fechada); log aceita e avisa', () => {
    const on = { META_LEAD_SIGNATURE: 'on', META_APP_SECRET: SECRET };
    expect(checkMetaNotification(body, { 'x-hub-signature-256': sign(body) }, on)).toMatchObject({ accept: true, reason: 'assinatura_ok' });
    expect(checkMetaNotification(body, {}, on)).toMatchObject({ accept: false, reason: 'sem_assinatura' });
    expect(checkMetaNotification(body, { 'x-hub-signature-256': sign(body) }, { META_LEAD_SIGNATURE: 'on' })).toMatchObject({ accept: false, reason: 'app_secret_nao_configurado' });
    expect(checkMetaNotification(body, {}, { META_APP_SECRET: SECRET })).toMatchObject({ accept: true, policy: 'log', reason: 'sem_assinatura' });
  });
});

describe('metaNotificationGuard', () => {
  const run = (env, headers, raw = body) => {
    const req = { body: raw, headers };
    const res = { sendStatus: vi.fn(() => res) };
    const next = vi.fn();
    const log = { warn: vi.fn() };
    metaNotificationGuard({ env, log })(req, res, next);
    return { req, res, next, log };
  };
  const on = { META_LEAD_SIGNATURE: 'on', META_APP_SECRET: SECRET };

  it('com assinatura válida transforma o corpo em JSON e segue', () => {
    const { req, next, res } = run(on, { 'x-hub-signature-256': sign(body) });
    expect(next).toHaveBeenCalledOnce();
    expect(res.sendStatus).not.toHaveBeenCalled();
    expect(req.body.entry[0].changes[0].value.leadgen_id).toBe('L1');
  });
  it('com on e assinatura errada responde 403 sem chegar ao controller nem registrar o corpo', () => {
    const { next, res, log } = run(on, { 'x-hub-signature-256': sign(body, 'outro') });
    expect(next).not.toHaveBeenCalled();
    expect(res.sendStatus).toHaveBeenCalledWith(403);
    expect(log.warn.mock.calls.flat().join(' ')).not.toContain('L1');
    expect(log.warn.mock.calls.flat().join(' ')).not.toContain(SECRET);
  });
  it('com log aceita sem assinatura e avisa; JSON inválido assinado dá 400', () => {
    const a = run({ META_APP_SECRET: SECRET }, {});
    expect(a.next).toHaveBeenCalledOnce();
    expect(a.log.warn).toHaveBeenCalled();
    const bad = Buffer.from('{nao-e-json');
    const b = run(on, { 'x-hub-signature-256': sign(bad) }, bad);
    expect(b.res.sendStatus).toHaveBeenCalledWith(400);
    expect(b.next).not.toHaveBeenCalled();
  });
});
