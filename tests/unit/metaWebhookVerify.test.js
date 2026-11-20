/**
 * Verificação do webhook de leads da Meta: sem valor padrão no código (o repositório é público).
 */
import { describe, it, expect } from 'vitest';
import { verifyMetaSubscription } from '../../utils/metaWebhookVerify.js';

describe('verifyMetaSubscription', () => {
  it('sem token configurado recusa, inclusive o antigo valor fixo', () => {
    expect(verifyMetaSubscription({ 'hub.mode': 'subscribe', 'hub.verify_token': 'fono_inova_2025', 'hub.challenge': 'c1' }, undefined).status).toBe(403);
    expect(verifyMetaSubscription({ 'hub.mode': 'subscribe', 'hub.verify_token': '', 'hub.challenge': 'c1' }, '').status).toBe(403);
  });

  it('com token configurado aceita só ele e devolve o challenge', () => {
    expect(verifyMetaSubscription({ 'hub.mode': 'subscribe', 'hub.verify_token': 'fono_inova_2025' }, 'token-ficticio').status).toBe(403);
    expect(verifyMetaSubscription({ 'hub.mode': 'subscribe', 'hub.verify_token': 'token-ficticio', 'hub.challenge': 'c2' }, 'token-ficticio')).toEqual({ status: 200, body: 'c2' });
  });

  it('exige hub.mode=subscribe e não aceita token vazio contra env vazio', () => {
    expect(verifyMetaSubscription({ 'hub.mode': 'unsubscribe', 'hub.verify_token': 't' }, 't').status).toBe(403);
    expect(verifyMetaSubscription({ 'hub.mode': 'subscribe' }, undefined).status).toBe(403);
    expect(verifyMetaSubscription({ 'hub.mode': 'subscribe', 'hub.verify_token': ' t ', 'hub.challenge': 'c' }, 't ')).toEqual({ status: 200, body: 'c' });
  });

  it('nenhum handler de verificação registra ou devolve o token esperado', async () => {
    const fs = await import('node:fs');
    for (const f of ['../../server.js', '../../controllers/whatsappController.js', '../../routes/whatsapp.js']) {
      const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src).not.toMatch(/tokenExpected|Env token|tokenPreview|envToken:/);
    }
  });

  it('o controller não tem valor fixo: só META_VERIFY_TOKEN ou, sem ele, WHATSAPP_VERIFY_TOKEN', async () => {
    const fs = await import('node:fs');
    const src = fs.readFileSync(new URL('../../controllers/leadController.js', import.meta.url), 'utf8');
    expect(src).not.toMatch(/VERIFY_TOKEN\s*\|\|\s*['"`]/);
    expect(src).toMatch(/verifyMetaSubscription\(req\.query, process\.env\.META_VERIFY_TOKEN \|\| process\.env\.WHATSAPP_VERIFY_TOKEN\)/);
  });
});
