/**
 * 🔐 Codemod: remove URI de produção hardcoded (com credencial) dos scripts
 *
 * Incidente 2026-08-07: credencial do cluster MongoDB de produção encontrada em
 * texto puro em 53 arquivos do repositório, incluindo a suite `back/tests/e2e/v2`.
 *
 * Transformações:
 *   process.env.MONGO_URI || 'mongodb+srv://user:senha@...'  →  process.env.MONGO_URI
 *   const X = 'mongodb+srv://user:senha@...'                 →  const X = process.env.MONGO_URI
 *   qualquer literal remanescente                            →  process.env.MONGO_URI
 *
 * Não substitui placeholders genéricos (user:senha@host, <password>).
 *
 * Uso:
 *   node scripts/codemod-remove-hardcoded-mongo-uri.js          # dry-run
 *   node scripts/codemod-remove-hardcoded-mongo-uri.js --apply
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const APPLY = process.argv.includes('--apply');

// Só credenciais REAIS. Placeholders de documentação ficam.
const CLUSTER_REAL = 'cluster0.g2c3sdk.mongodb.net';

const EXT = new Set(['.js', '.mjs', '.ts', '.tsx', '.json', '.sh', '.yml', '.yaml', '.md']);
const IGNORAR = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (IGNORAR.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (EXT.has(path.extname(entry.name))) yield full;
  }
}

// literal completo entre aspas simples, duplas ou crase
const LITERAL = new RegExp(`(['"\`])mongodb\\+srv://[^'"\`]*${CLUSTER_REAL.replace(/\./g, '\\.')}[^'"\`]*\\1`, 'g');

let arquivos = 0, ocorrencias = 0;
const tocados = [];

for (const file of walk(ROOT)) {
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
  if (!src.includes(CLUSTER_REAL)) continue;

  const antes = src;
  let n = 0;

  // 1. fallback: process.env.X || 'literal'  →  process.env.X
  src = src.replace(
    new RegExp(`(process\\.env\\.[A-Z_]+\\s*\\|\\|\\s*)${LITERAL.source}`, 'g'),
    (_m, prefix) => { n++; return prefix.replace(/\s*\|\|\s*$/, ''); }
  );

  // 2. literal solto → process.env.MONGO_URI
  src = src.replace(LITERAL, () => { n++; return 'process.env.MONGO_URI'; });

  // 3. shell: VAR="literal" → VAR="$MONGO_URI"
  if (path.extname(file) === '.sh') {
    src = src.replace(/mongodb\+srv:\/\/[^"'\s]*cluster0\.g2c3sdk\.mongodb\.net[^"'\s]*/g,
      () => { n++; return '$MONGO_URI'; });
  }

  if (src === antes) continue;
  arquivos++; ocorrencias += n;
  tocados.push(`${path.relative(ROOT, file)}  (${n})`);
  if (APPLY) fs.writeFileSync(file, src);
}

console.log(`\n${APPLY ? '🔴 APLICADO' : '🔵 DRY-RUN'} — credencial de produção hardcoded\n`);
tocados.forEach(t => console.log(`   ${t}`));
console.log(`\n   arquivos: ${arquivos} | ocorrências: ${ocorrencias}`);
if (!APPLY) console.log(`\n🔵 DRY-RUN — nada gravado. Rode com --apply.`);
else console.log(`\n⚠️  Remover do código NÃO invalida o segredo. Rotacione a credencial no Atlas.`);
