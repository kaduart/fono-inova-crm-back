/**
 * Testes do higienizador de conteúdo do GMB (puro, sem banco/rede).
 * Rodar: node tests/gmb/contentSanitizer.test.mjs
 */
import assert from 'node:assert/strict';
import { limparConteudoGmb, extrairUrl } from '../../services/gmbContentSanitizer.js';

let passed = 0, failed = 0;
const t = (nome, fn) => { try { fn(); console.log('✅', nome); passed++; } catch (e) { console.error('❌', nome, '\n   ', e.message); failed++; } };

// Caso real (post de julho) — telefone/URL/keywords no corpo + frase truncada + claim "gratuita"
const julho = [
  'Seu filho tem 2 anos e ainda não fala? Saiba quando procurar ajuda e como funciona a avaliação fonoaudiológica na Clínica Fono Inova em Anápolis.',
  '',
  '🔇 Não fala pelo menos 20 palavras',
  '🗣️ Não junta duas palavras',
  '👂 Não responde quando chamada',
  '',
  '✅ A avaliação fonoaudiológica dura cerca de 1 hora. Fazemos testes específicos para entender o desenvo',
  '',
  '🔍 Palavras-chave: criança não fala, 2 anos não fala, atraso fala',
  '',
  '👉 Saiba mais: clinicafonoinova.com.br/lp/crianca-2-anos-nao-fala',
  '',
  '📱 Agende sua avaliação gratuita: (62) 99201-3573',
].join('\n');

t('remove telefone do corpo', () => assert.ok(!/\(62\)/.test(limparConteudoGmb(julho))));
t('remove URL do corpo', () => assert.ok(!/clinicafonoinova\.com\.br/.test(limparConteudoGmb(julho))));
t('remove linha de Palavras-chave', () => assert.ok(!/Palavras-chave/i.test(limparConteudoGmb(julho))));
t('remove claim "avaliação gratuita"', () => assert.ok(!/gratuita/i.test(limparConteudoGmb(julho))));
t('corta frase incompleta e fecha em "1 hora."', () => assert.ok(limparConteudoGmb(julho).endsWith('dura cerca de 1 hora.')));
t('mantém os bullets de sinais de alerta', () => {
  const out = limparConteudoGmb(julho);
  assert.ok(out.includes('Não fala pelo menos 20 palavras') && out.includes('Não responde quando chamada'));
});
t('extrai a URL para o botão', () => assert.equal(extrairUrl(julho), 'https://clinicafonoinova.com.br/lp/crianca-2-anos-nao-fala'));

// Idempotência: limpar 2x = limpar 1x
t('idempotente (limpar de novo não muda)', () => {
  const a = limparConteudoGmb(julho);
  assert.equal(limparConteudoGmb(a), a);
});

// Não mexe em conteúdo já limpo e completo
const limpo = 'Fonoaudiologia infantil em Anápolis.\n\nAcompanhamento individualizado para cada criança.';
t('conteúdo já limpo passa intacto', () => assert.equal(limparConteudoGmb(limpo), limpo));
t('sem URL → extrairUrl retorna null', () => assert.equal(extrairUrl(limpo), null));

console.log(`\n${passed} passaram, ${failed} falharam`);
process.exit(failed ? 1 : 0);
