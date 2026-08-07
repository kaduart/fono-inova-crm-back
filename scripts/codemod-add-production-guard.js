/**
 * 🔒 Codemod: injeta assertNotProductionDb() nos scripts/tests que escrevem no banco
 *
 * ADR-016. Insere o import e a chamada do guard imediatamente antes do primeiro
 * `mongoose.connect(...)` de cada arquivo alvo.
 *
 * Uso:
 *   node scripts/codemod-add-production-guard.js          # dry-run
 *   node scripts/codemod-add-production-guard.js --apply
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACK = path.resolve(__dirname, '..');
const APPLY = process.argv.includes('--apply');

const ALVOS = [
  'scripts/manual-test-guide-closure.mjs',
  'scripts/validar-fluxos-producao.js',
  'scripts/cleanup-e2e-patient.js',
  'tests/e2e/v2/chaos.v2.e2e.test.js',
  'tests/e2e/v2/convenio-flow.v2.e2e.test.js',
  'tests/e2e/v2/full-flow.v2.e2e.test.js',
  'tests/e2e/v2/liminar-flow.v2.e2e.test.js',
  'tests/e2e/v2/package-flow.v2.e2e.test.js',
  'tests/e2e/v2/replay.v2.e2e.test.js',
  'tests/e2e/v2/worker-integration.v2.e2e.test.js'
];

const resultados = [];

for (const rel of ALVOS) {
  const file = path.join(BACK, rel);
  if (!fs.existsSync(file)) { resultados.push(`${rel} — ❌ não existe`); continue; }

  let src = fs.readFileSync(file, 'utf8');
  if (src.includes('assertNotProductionDb')) { resultados.push(`${rel} — já protegido`); continue; }

  const idx = src.search(/(await\s+)?mongoose\.connect\s*\(/);
  if (idx === -1) { resultados.push(`${rel} — ⚠️  sem mongoose.connect, revisar à mão`); continue; }

  // caminho relativo do util a partir do arquivo
  const importPath = path.relative(path.dirname(file), path.join(BACK, 'utils/assertNotProductionDb.js'))
    .split(path.sep).join('/');
  const importLine = `import { assertNotProductionDb } from '${importPath.startsWith('.') ? importPath : './' + importPath}';\n`;

  // 1. import: depois do último import do topo
  const imports = [...src.matchAll(/^import .*?;$/gm)];
  if (imports.length) {
    const last = imports[imports.length - 1];
    const pos = last.index + last[0].length + 1;
    src = src.slice(0, pos) + importLine + src.slice(pos);
  } else {
    src = importLine + src;
  }

  // 2. guard antes do connect (índice recalculado após o import)
  const idx2 = src.search(/([ \t]*)(await\s+)?mongoose\.connect\s*\(/);
  const linhaInicio = src.lastIndexOf('\n', idx2) + 1;
  const indent = (src.slice(linhaInicio, idx2).match(/^[ \t]*/) || [''])[0];
  const guard =
    `${indent}// 🔒 ADR-016 — script de teste/diagnóstico não escreve em produção\n` +
    `${indent}assertNotProductionDb({\n` +
    `${indent}  mongoUri: process.env.MONGO_URI || process.env.MONGODB_URI,\n` +
    `${indent}  scriptName: '${rel}'\n` +
    `${indent}});\n\n`;
  src = src.slice(0, linhaInicio) + guard + src.slice(linhaInicio);

  if (APPLY) fs.writeFileSync(file, src);
  resultados.push(`${rel} — ✅ guard inserido`);
}

console.log(`\n${APPLY ? '🔴 APLICADO' : '🔵 DRY-RUN'} — guard de produção\n`);
resultados.forEach(r => console.log(`   ${r}`));
if (!APPLY) console.log(`\n🔵 DRY-RUN — nada gravado. Rode com --apply.`);
