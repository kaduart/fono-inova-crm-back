/**
 * Testes do wrapper de texto via Anthropic (sem rede — fetch é mockado).
 * Rodar: node tests/gmb/aiText.test.mjs
 */
import assert from 'node:assert/strict';
import { gerarTextoIA } from '../../services/aiText.js';

let passed = 0, failed = 0;
const t = async (nome, fn) => { try { await fn(); console.log('✅', nome); passed++; } catch (e) { console.error('❌', nome, '\n   ', e.message); failed++; } };

const realFetch = globalThis.fetch;
const restore = () => { globalThis.fetch = realFetch; };

// 1) Sem chave → lança (chamador cai no template)
await t('sem ANTHROPIC_API_KEY lança', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await assert.rejects(() => gerarTextoIA([{ role: 'user', content: 'oi' }]));
});

// 2) Mapeia system separado, manda messages só com user/assistant, e extrai o texto
await t('mapeia system + extrai texto', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  process.env.ANTHROPIC_MODEL = 'modelo-x';
  let capturado = null;
  globalThis.fetch = async (url, opts) => {
    capturado = { url, body: JSON.parse(opts.body), headers: opts.headers };
    return { ok: true, json: async () => ({ content: [{ type: 'text', text: 'Post gerado pela Claude.' }] }) };
  };
  const out = await gerarTextoIA(
    [{ role: 'system', content: 'Você é social media.' }, { role: 'user', content: 'Crie o post.' }],
    { maxTokens: 123, temperature: 0.5 }
  );
  assert.equal(out, 'Post gerado pela Claude.');
  assert.equal(capturado.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(capturado.body.system, 'Você é social media.');       // system separado
  assert.equal(capturado.body.messages.length, 1);                   // só o user
  assert.equal(capturado.body.messages[0].role, 'user');
  assert.equal(capturado.body.model, 'modelo-x');
  assert.equal(capturado.body.max_tokens, 123);
  assert.equal(capturado.headers['x-api-key'], 'test-key');
  assert.equal(capturado.headers['anthropic-version'], '2023-06-01');
});

// 3) HTTP != ok → lança com status (ex.: crédito acabou / modelo inválido)
await t('erro HTTP lança', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => 'bad model' });
  await assert.rejects(() => gerarTextoIA([{ role: 'user', content: 'x' }]), /Anthropic 400/);
});

// 4) Resposta vazia → lança
await t('resposta vazia lança', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ content: [] }) });
  await assert.rejects(() => gerarTextoIA([{ role: 'user', content: 'x' }]), /vazia/);
});

restore();
console.log(`\n${passed} passaram, ${failed} falharam`);
process.exit(failed ? 1 : 0);
