#!/usr/bin/env node
/**
 * Classificação por CASO de teste (complementa a catraca por arquivo).
 *
 * A catraca por arquivo (ratchet.mjs tests) não percebe um teste NOVO
 * falhando dentro de um arquivo que já estava na linha de base. Este script
 * separa, a partir do relatório JSON do vitest:
 *   - aprovados;
 *   - falhas antigas (na linha de base por caso);
 *   - regressões novas (fora da linha de base)  → sai com erro;
 *   - casos da linha de base que passaram a passar → aviso para remover.
 *
 * Linha de base: uma entrada por linha.
 *   <arquivo> > <nome completo do teste>   (teste que falha)
 *   <arquivo> [carregamento]                (arquivo que nem carrega)
 *
 * Uso:
 *   node .github/ci/classificar-testes.mjs <vitest-report.json> <baseline-casos.txt> [--gerar]
 * --gerar imprime a linha de base atual (para criar/atualizar o arquivo).
 */
import fs from 'node:fs';
import path from 'node:path';

const [reportFile, baselineFile, flag] = process.argv.slice(2);
const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
const root = process.cwd();
const rel = (f) => path.relative(root, f).split(path.sep).join('/');

const failing = new Set();
let passed = 0;
let skipped = 0;
for (const file of report.testResults || []) {
  const name = rel(file.name);
  const cases = file.assertionResults || [];
  let failedCases = 0;
  for (const c of cases) {
    if (c.status === 'passed') passed++;
    else if (c.status === 'failed') {
      failedCases++;
      failing.add([name, ...(c.ancestorTitles || []), c.title].join(' > '));
    } else skipped++;
  }
  // Arquivo que não carrega, ou falha de suíte (hook) sem caso falho.
  if (file.status === 'failed' && failedCases === 0) failing.add(`${name} [carregamento]`);
}

if (flag === '--gerar') {
  console.log('# Linha de base por caso. Gerada com: node .github/ci/classificar-testes.mjs <relatorio> <este-arquivo> --gerar');
  console.log([...failing].sort().join('\n'));
  process.exit(0);
}

const baseline = new Set(
  (fs.existsSync(baselineFile) ? fs.readFileSync(baselineFile, 'utf8') : '')
    .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
);
const antigas = [...failing].filter((f) => baseline.has(f)).sort();
const novas = [...failing].filter((f) => !baseline.has(f)).sort();
const corrigidas = [...baseline].filter((f) => !failing.has(f)).sort();

const lines = [
  `### Testes por caso`,
  `- Aprovados: ${passed}`,
  `- Pulados/todo: ${skipped}`,
  `- Falhas antigas (linha de base): ${antigas.length}`,
  `- Regressões novas: ${novas.length}`,
  `- Casos da linha de base que agora passam: ${corrigidas.length}`,
  '',
  '**CI verde não significa suíte integralmente aprovada enquanto houver falhas antigas.**'
];
if (novas.length) lines.push('', '#### Regressões novas', ...novas.map((f) => `- ${f}`));
if (corrigidas.length) lines.push('', '#### Remover da linha de base', ...corrigidas.map((f) => `- ${f}`));
const summary = lines.join('\n');
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

for (const f of corrigidas) console.log(`::notice::Caso da linha de base agora passa; remova: ${f}`);
if (novas.length) {
  for (const f of novas) console.log(`::error::Regressão nova: ${f}`);
  process.exit(1);
}
