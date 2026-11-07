/**
 * Testes ISOLADOS da seleção de imagem (regressão GMB).
 * Dados sintéticos, sem banco, sem Make, sem publicação real.
 * Rodar: node tests/gmb/imageBankMap.test.mjs
 */
import assert from 'node:assert/strict';
import {
  especialidadeBaseParaBanco,
  buscarImagemBancoPorBase,
  BANCO_ESPECIALIDADES,
} from '../../services/gmbImageBankMap.js';

let passed = 0, failed = 0;
const tAsync = async (nome, fn) => {
  try { await fn(); console.log('✅', nome); passed++; }
  catch (e) { console.error('❌', nome, '\n    ->', e.message); failed++; }
};

// Banco sintético: só as 6 bases reais têm imagem.
const bancoFake = {
  fonoaudiologia: 'https://cdn/fono.jpg',
  terapia_ocupacional: 'https://cdn/to.jpg',
  psicomotricidade: 'https://cdn/psicomotor.jpg',
  musicoterapia: 'https://cdn/musico.jpg',
  psicopedagogia: 'https://cdn/psicoped.jpg',
  autismo: 'https://cdn/autismo.jpg',
};
const buscarFake = async (esp) => (bancoFake[esp] ? { url: bancoFake[esp], publicId: esp + '_1' } : null);

// 1. Geração de post de fonoaudiologia com imagem
await tAsync('1. Post de fonoaudiologia recebe imagem de fono', async () => {
  assert.equal(especialidadeBaseParaBanco('fonoaudiologia_infantil_anapolis'), 'fonoaudiologia');
  const r = await buscarImagemBancoPorBase('fonoaudiologia_infantil_anapolis', 'atraso de fala', buscarFake);
  assert.equal(r.url, 'https://cdn/fono.jpg');
  assert.equal(r.base, 'fonoaudiologia');
});

// 2. Seleção de imagem COMPATÍVEL (nunca incoerente)
await tAsync('2. Mapeia para a especialidade compatível', async () => {
  assert.equal(especialidadeBaseParaBanco('terapia_ocupacional_anapolis'), 'terapia_ocupacional');
  assert.equal(especialidadeBaseParaBanco('psicomotricidade_anapolis'), 'psicomotricidade');
  const r = await buscarImagemBancoPorBase('terapia_ocupacional_anapolis', 'seletividade alimentar', buscarFake);
  assert.equal(r.base, 'terapia_ocupacional');
});

// 3. Imagem da base quando o tema específico não casa
await tAsync('3. Cai para imagem da base quando o tema específico não existe', async () => {
  const buscarSoBase = async (esp, tema) => (!tema && bancoFake[esp] ? { url: bancoFake[esp], publicId: esp } : null);
  const r = await buscarImagemBancoPorBase('psicopedagogia_anapolis', 'tema inexistente xyz', buscarSoBase);
  assert.equal(r.base, 'psicopedagogia');
});

// 4. Ausência de imagem elegível -> null (NÃO foto incoerente)
await tAsync('4. Especialidade sem imagem coerente retorna null (needs_review)', async () => {
  assert.equal(especialidadeBaseParaBanco('psicologia_infantil_anapolis'), null);
  assert.equal(especialidadeBaseParaBanco('avaliacao_neuropsicologica_anapolis'), null);
  const r = await buscarImagemBancoPorBase('psicologia_infantil_anapolis', 'ansiedade', buscarFake);
  assert.equal(r, null);
});

// 5. IA desativada: a seleção NUNCA gera — só reutiliza o banco
await tAsync('5. Seleção não gera IA; banco vazio -> null (sem fabricar imagem)', async () => {
  let chamou = 0;
  const buscarContado = async (esp, t, o) => { chamou++; return buscarFake(esp, t, o); };
  const r = await buscarImagemBancoPorBase('musicoterapia_anapolis', 'expressao', buscarContado);
  assert.ok(chamou >= 1, 'deve consultar o banco');
  assert.equal(r.base, 'musicoterapia');
  const vazio = await buscarImagemBancoPorBase('fonoaudiologia_anapolis', 'x', async () => null);
  assert.equal(vazio, null);
});

// 6. Recuperação de pendente reutiliza o banco (sem forceNew)
await tAsync('6. Recuperação reaproveita imagem do banco', async () => {
  const r = await buscarImagemBancoPorBase('autismo', 'contato visual', buscarFake);
  assert.equal(r.url, 'https://cdn/autismo.jpg');
  assert.equal(r.reused, true);
});

// Cobertura: toda base real mapeia para si mesma
await tAsync('Cobertura: bases reais mapeiam para a própria chave', async () => {
  for (const b of BANCO_ESPECIALIDADES) assert.equal(especialidadeBaseParaBanco(b), b);
});

console.log(`\n${passed} passaram, ${failed} falharam`);
process.exit(failed ? 1 : 0);
