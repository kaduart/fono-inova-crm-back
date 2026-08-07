/**
 * 🔒 Guard operacional: script de teste/diagnóstico não escreve em produção
 *
 * Invariante (ADR-016 / DOMAIN_INVARIANTS.md):
 *   Scripts de teste, diagnóstico e validação nunca podem escrever no banco de
 *   produção sem autorização explícita e específica.
 *
 * Motivo: em 2026-08-07 foram removidos 46 pacientes de teste, 15 guias e 1
 * convênio de produção — 2ª limpeza em 3 dias. A origem eram scripts em
 * `back/scripts/` e a suite `back/tests/e2e/v2/` com a URI de produção
 * hardcoded, rodando contra `fono_inova_prod`.
 *
 * Uso — SEMPRE antes de mongoose.connect():
 *
 *   import { assertNotProductionDb } from '../utils/assertNotProductionDb.js';
 *
 *   assertNotProductionDb({
 *     mongoUri: process.env.MONGO_URI,
 *     scriptName: 'preparar-guia-para-teste-ui.mjs'
 *   });
 *
 * Sinais que abortam:
 *   - NODE_ENV=production
 *   - RENDER / RENDER_SERVICE_ID presentes (ambiente de produção conhecido)
 *   - URI contendo o cluster ou o banco de produção
 *   - DB_NAME igual ao banco produtivo
 *
 * Escrita de dado de teste exige liberação explícita mesmo fora de produção:
 *   ALLOW_TEST_DATA_WRITE=true node scripts/...
 */

const BANCOS_PRODUTIVOS = ['fono_inova_prod'];
const CLUSTERS_PRODUTIVOS = ['cluster0.g2c3sdk.mongodb.net'];

export class ProductionWriteBlocked extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProductionWriteBlocked';
    this.code = 'PRODUCTION_WRITE_BLOCKED';
  }
}

/**
 * @param {object}  opts
 * @param {string}  opts.mongoUri    URI que o script vai usar
 * @param {string}  opts.scriptName  nome do script, só para a mensagem de erro
 * @param {boolean} [opts.writes]    true se o script cria/altera dados (default: true)
 */
export function assertNotProductionDb({ mongoUri, scriptName, writes = true }) {
  const sinais = [];
  const uri = String(mongoUri || '');

  if (!uri) {
    throw new ProductionWriteBlocked(
      `[${scriptName}] MONGO_URI não definida. Defina a variável de ambiente — ` +
      `nunca escreva a URI no código.`
    );
  }

  if (process.env.NODE_ENV === 'production') sinais.push('NODE_ENV=production');
  if (process.env.RENDER || process.env.RENDER_SERVICE_ID) sinais.push('ambiente Render');

  for (const banco of BANCOS_PRODUTIVOS) {
    if (uri.includes(banco)) sinais.push(`URI aponta para o banco "${banco}"`);
    if (process.env.DB_NAME === banco) sinais.push(`DB_NAME=${banco}`);
  }
  for (const cluster of CLUSTERS_PRODUTIVOS) {
    if (uri.includes(cluster)) sinais.push(`URI aponta para o cluster de produção "${cluster}"`);
  }

  if (sinais.length) {
    throw new ProductionWriteBlocked(
      `\n🔒 [${scriptName}] BLOQUEADO — este script escreve no banco e o destino é PRODUÇÃO.\n` +
      sinais.map(s => `     · ${s}`).join('\n') +
      `\n\n   Scripts de teste/diagnóstico não podem escrever em produção (ADR-016).` +
      `\n   Aponte MONGO_URI para um banco local ou de staging.\n`
    );
  }

  if (writes && process.env.ALLOW_TEST_DATA_WRITE !== 'true') {
    throw new ProductionWriteBlocked(
      `\n🔒 [${scriptName}] BLOQUEADO — script cria/altera dados e a liberação explícita não foi dada.\n` +
      `\n   Rode assim, e só se souber exatamente o que está fazendo:\n` +
      `     ALLOW_TEST_DATA_WRITE=true node ${scriptName}\n`
    );
  }
}

/**
 * Marcadores obrigatórios em qualquer documento criado por script de teste.
 * Permitem limpeza determinística no `finally`, sem depender de nome/heurística.
 */
export function testDataMarkers(testRunId) {
  return { _testData: true, testRunId };
}

export default assertNotProductionDb;
