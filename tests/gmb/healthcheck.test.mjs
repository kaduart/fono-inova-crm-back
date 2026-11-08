/**
 * Testes do classificador de saúde do GMB (puro, sem banco/rede).
 * Rodar: node tests/gmb/healthcheck.test.mjs
 */
import assert from 'node:assert/strict';
import { classificarSaudeGmb } from '../../services/gmbHealthcheck.js';

let passed = 0, failed = 0;
const t = (nome, fn) => { try { fn(); console.log('✅', nome); passed++; } catch (e) { console.error('❌', nome, '\n   ', e.message); failed++; } };

const meioDia = new Date(2026, 10, 9, 13, 0, 0); // 13h → já passou a janela de envio
const manha   = new Date(2026, 10, 9, 9, 0, 0);  // 9h  → ainda dentro da janela

t('nenhum post criado hoje → crítico', () => {
  const r = classificarSaudeGmb({ posts: [], now: meioDia });
  assert.equal(r.ok, false); assert.equal(r.nivel, 'critico');
  assert.match(r.titulo, /nenhum post criado/i);
});

t('post criado e publicado → ok', () => {
  const r = classificarSaudeGmb({ posts: [{ status: 'publishing_retry' }], now: meioDia });
  assert.equal(r.ok, true); assert.equal(r.nivel, 'ok');
});

t('unconfirmed conta como enviado → ok', () => {
  const r = classificarSaudeGmb({ posts: [{ status: 'unconfirmed' }], now: meioDia });
  assert.equal(r.ok, true);
});

t('criado mas não enviado após a janela → crítico', () => {
  const r = classificarSaudeGmb({ posts: [{ status: 'scheduled' }], now: meioDia });
  assert.equal(r.ok, false); assert.equal(r.nivel, 'critico');
  assert.match(r.titulo, /não publicado/i);
});

t('criado sem imagem (needs_review) → aviso', () => {
  const r = classificarSaudeGmb({ posts: [{ status: 'needs_review' }], now: meioDia });
  assert.equal(r.ok, false); assert.equal(r.nivel, 'aviso');
});

t('criado de manhã, envio ainda na janela → ok/pendente (não alarma cedo)', () => {
  const r = classificarSaudeGmb({ posts: [{ status: 'scheduled' }], now: manha });
  assert.equal(r.ok, true); assert.equal(r.nivel, 'pendente');
});

t('mistura: 1 enviado + 1 needs_review → ok (pelo menos um saiu)', () => {
  const r = classificarSaudeGmb({ posts: [{ status: 'published' }, { status: 'needs_review' }], now: meioDia });
  assert.equal(r.ok, true);
});

console.log(`\n${passed} passaram, ${failed} falharam`);
process.exit(failed ? 1 : 0);
