#!/usr/bin/env node
/**
 * 🔍 Legacy Write Scanner v2
 *
 * Varre todos os arquivos JS, encontra writes V1 e classifica por tipo:
 * - CREATE: criação de objetos (insertMany, new, objetos literais)
 * - UPDATE: atualização (findByIdAndUpdate, updateOne, save, assignment direto)
 * - EVENT: workers, eventos, callbacks
 */

import { glob } from 'glob';
import fs from 'fs';
import path from 'path';

const TARGET_DIRS = ['controllers', 'routes', 'services', 'workers'];
const PATTERNS = [
  /isPaid\s*(=|:)\s*(true|false)/,
  /paymentStatus\s*(=|:)\s*['"](paid|unpaid|pending|package_paid)['"]/
];

function classifyContext(lines, matchLineIdx) {
  // Pega 5 linhas antes e depois
  const start = Math.max(0, matchLineIdx - 5);
  const end = Math.min(lines.length, matchLineIdx + 6);
  const context = lines.slice(start, end).join('\n');

  // Heurísticas de classificação
  const lowerContext = context.toLowerCase();

  // CREATE signals
  if (
    lowerContext.includes('insertmany') ||
    lowerContext.includes('insertone') ||
    lowerContext.includes('create(') ||
    lowerContext.includes('new ') ||
    lowerContext.includes('docs.push') ||
    lowerContext.includes('const ') && lowerContext.includes('docs') ||
    lowerContext.includes('map(') && lowerContext.includes('=> ({')
  ) {
    return 'CREATE';
  }

  // EVENT signals
  if (
    lowerContext.includes('worker') ||
    lowerContext.includes('event') ||
    lowerContext.includes('consumer') ||
    lowerContext.includes('process.') ||
    lowerContext.includes('job') ||
    lowerContext.includes('queue') ||
    lowerContext.includes('handler')
  ) {
    return 'EVENT';
  }

  // UPDATE signals
  if (
    lowerContext.includes('findbyidandupdate') ||
    lowerContext.includes('updateone') ||
    lowerContext.includes('updatemany') ||
    lowerContext.includes('.save(') ||
    lowerContext.includes('$set') ||
    lowerContext.includes('$push')
  ) {
    return 'UPDATE';
  }

  // Se tem assignment direto (=) sem sinais de create, é UPDATE
  if (lines[matchLineIdx].includes('=')) {
    return 'UPDATE';
  }

  return 'UNKNOWN';
}

function getFileCategory(filePath) {
  if (filePath.includes('worker')) return 'WORKER';
  if (filePath.includes('service')) return 'SERVICE';
  if (filePath.includes('controller')) return 'CONTROLLER';
  if (filePath.includes('route')) return 'ROUTE';
  return 'OTHER';
}

const allFiles = [];
for (const dir of TARGET_DIRS) {
  const files = await glob(`${dir}/**/*.js`, {
    cwd: '/home/user/projetos/crm/back',
    ignore: ['**/node_modules/**', '**/test*', '**/scripts/**']
  });
  allFiles.push(...files);
}

const findings = [];

for (const file of allFiles) {
  const content = fs.readFileSync(`/home/user/projetos/crm/back/${file}`, 'utf-8');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of PATTERNS) {
      if (pattern.test(line)) {
        const type = classifyContext(lines, i);
        const category = getFileCategory(file);
        findings.push({
          file,
          category,
          line: i + 1,
          code: line.trim(),
          type,
          field: line.includes('isPaid') ? 'isPaid' : 'paymentStatus',
          value: line.match(/(true|false|'paid'|'unpaid'|'pending'|'package_paid')/)?.[0] || 'unknown'
        });
        break; // só conta uma vez por linha
      }
    }
  }
}

// Agrupar
const byType = { CREATE: [], UPDATE: [], EVENT: [], UNKNOWN: [] };
const byFile = {};
const byCategory = {};

for (const f of findings) {
  byType[f.type].push(f);
  if (!byFile[f.file]) byFile[f.file] = [];
  byFile[f.file].push(f);
  if (!byCategory[f.category]) byCategory[f.category] = 0;
  byCategory[f.category]++;
}

console.log('══════════════════════════════════════════════════════════════════');
console.log('  🔍 LEGACY WRITE SCANNER v2 — RELATÓRIO COMPLETO');
console.log('══════════════════════════════════════════════════════════════════');
console.log(`\nTotal: ${findings.length} writes legados em ${Object.keys(byFile).length} arquivos\n`);

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('POR TIPO (classificação):');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  🔴 CREATE: ${byType.CREATE.length} (mais crítico — entra podre no banco)`);
console.log(`  🟠 UPDATE: ${byType.UPDATE.length} (atualiza inconsistência)`);
console.log(`  🟡 EVENT:  ${byType.EVENT.length} (workers/eventos)`);
console.log(`  ⚪ UNKNOWN: ${byType.UNKNOWN.length} (precisa revisar)`);

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('POR CATEGORIA (arquivo):');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
for (const [cat, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${cat}: ${count}`);
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('TOP 15 ARQUIVOS:');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
const sortedFiles = Object.entries(byFile).sort((a, b) => b[1].length - a[1].length);
for (const [file, entries] of sortedFiles.slice(0, 15)) {
  const types = entries.reduce((acc, e) => {
    acc[e.type] = (acc[e.type] || 0) + 1;
    return acc;
  }, {});
  const typeStr = Object.entries(types).map(([t, c]) => `${t}:${c}`).join(' ');
  console.log(`  ${file} = ${entries.length} (${typeStr})`);
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('DETALHES — TOP 10 MAIS CRÍTICOS (CREATE):');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

for (const f of byType.CREATE.slice(0, 10)) {
  console.log(`📄 ${f.file}:${f.line}`);
  console.log(`   ${f.code}`);
  console.log('');
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('DETALHES — TOP 10 MAIS FREQUENTES (UPDATE):');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

for (const f of byType.UPDATE.slice(0, 10)) {
  console.log(`📄 ${f.file}:${f.line}`);
  console.log(`   ${f.code}`);
  console.log('');
}

// Exportar JSON para uso posterior
const jsonOutput = JSON.stringify({
  summary: {
    total: findings.length,
    byType: {
      CREATE: byType.CREATE.length,
      UPDATE: byType.UPDATE.length,
      EVENT: byType.EVENT.length,
      UNKNOWN: byType.UNKNOWN.length
    },
    byCategory,
    files: Object.keys(byFile).length
  },
  findings
}, null, 2);

fs.writeFileSync('/home/user/projetos/crm/back/scripts/legacy-writes-report.json', jsonOutput);
console.log('\n✅ Relatório salvo em: scripts/legacy-writes-report.json');
