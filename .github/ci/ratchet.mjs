#!/usr/bin/env node
/**
 * Catraca do CI: o repositório já tem falhas antigas (testes, lint, tipos).
 * Em vez de esconder essas falhas, o CI roda TUDO e só fica vermelho quando
 * a mudança PIORA o estado: um arquivo de teste novo falhando, ou mais erros
 * de lint/tipos do que a linha de base.
 *
 * Uso:
 *   node .github/ci/ratchet.mjs tests <vitest-report.json> <baseline.txt>
 *   node .github/ci/ratchet.mjs syntax <lista-de-arquivos.txt> <baseline.txt>
 *   node .github/ci/ratchet.mjs count <nome> <numero-atual> <baseline.json>
 *
 * Quando algo melhora, o script avisa para baixar a linha de base no mesmo PR.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const [mode, ...args] = process.argv.slice(2);
const notice = (msg) => console.log(`::notice::${msg}`);
const error = (msg) => console.log(`::error::${msg}`);

function readBaselineList(file) {
  if (!fs.existsSync(file)) return new Set();
  return new Set(
    fs.readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')),
  );
}

function compareLists(label, failing, baselineFile) {
  const baseline = readBaselineList(baselineFile);
  const novos = [...failing].filter((f) => !baseline.has(f)).sort();
  const corrigidos = [...baseline].filter((f) => !failing.has(f)).sort();
  console.log(`${label}: ${failing.size} arquivo(s) falhando (linha de base: ${baseline.size}).`);
  if (failing.size) console.log(`Lista atual:\n${[...failing].sort().join('\n')}`);
  if (corrigidos.length) {
    notice(`${corrigidos.length} arquivo(s) da linha de base agora passam. Remova de ${baselineFile}: ${corrigidos.join(', ')}`);
  }
  if (novos.length) {
    for (const f of novos) error(`${label}: arquivo falhando que não estava na linha de base: ${f}`);
    process.exit(1);
  }
  console.log(`OK: nenhum arquivo novo falhando em ${label}.`);
  process.exit(0);
}

if (mode === 'tests') {
  const [reportFile, baselineFile] = args;
  if (!fs.existsSync(reportFile)) {
    error(`Relatório do vitest não encontrado (${reportFile}). O vitest quebrou antes de rodar os testes.`);
    process.exit(1);
  }
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const root = process.cwd();
  const failing = new Set(
    (report.testResults || [])
      .filter((r) => r.status !== 'passed' && r.status !== 'skipped' && r.status !== 'pending')
      .map((r) => path.relative(root, r.name).split(path.sep).join('/')),
  );
  console.log(`Testes: ${report.numPassedTests ?? '?'} passaram, ${report.numFailedTests ?? '?'} falharam.`);
  compareLists('testes', failing, baselineFile);
}

if (mode === 'syntax') {
  const [listFile, baselineFile] = args;
  const files = fs.readFileSync(listFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  const failing = new Set();
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) {
      failing.add(f);
      console.log(`--- ${f}\n${(r.stderr || '').split('\n').slice(0, 5).join('\n')}`);
    }
  }
  console.log(`Sintaxe conferida em ${files.length} arquivo(s).`);
  compareLists('sintaxe', failing, baselineFile);
}

if (mode === 'count') {
  const [name, currentRaw, baselineFile] = args;
  const current = Number(currentRaw);
  if (!Number.isFinite(current)) {
    error(`Contagem inválida para ${name}: "${currentRaw}"`);
    process.exit(1);
  }
  const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'));
  const max = baseline[name];
  if (typeof max !== 'number') {
    error(`Sem linha de base para "${name}" em ${baselineFile}`);
    process.exit(1);
  }
  console.log(`${name}: ${current} (linha de base: ${max}).`);
  if (current > max) {
    error(`${name} subiu de ${max} para ${current}. Corrija os ${current - max} novo(s) erro(s).`);
    process.exit(1);
  }
  if (current < max) {
    notice(`${name} caiu de ${max} para ${current}. Atualize "${name}": ${current} em ${baselineFile}.`);
  }
  process.exit(0);
}

error(`Modo desconhecido: ${mode}`);
process.exit(1);
