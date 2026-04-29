#!/usr/bin/env node
/**
 * 🔍 Audit Legacy Financial Writes
 */

import { glob } from 'glob';
import fs from 'fs';

const PATTERNS = [
  /isPaid\s*=\s*(true|false)/g,
  /paymentStatus\s*=\s*['"](paid|unpaid|pending)['"]/g,
  /isPaid\s*:\s*(true|false)/g,
  /paymentStatus\s*:\s*['"](paid|unpaid|pending)['"]/g
];

const files = await glob('**/*.{js,ts}', {
  cwd: '/home/user/projetos/crm/back',
  ignore: ['node_modules/**', '**/test*', '**/scripts/**']
});

let total = 0;
const byFile = {};

for (const file of files) {
  const content = fs.readFileSync(`/home/user/projetos/crm/back/${file}`, 'utf-8');
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of PATTERNS) {
      if (pattern.test(line)) {
        if (!byFile[file]) byFile[file] = [];
        byFile[file].push({ line: i + 1, code: line.trim() });
        total++;
      }
      pattern.lastIndex = 0; // reset regex
    }
  }
}

const sortedFiles = Object.entries(byFile).sort((a, b) => b[1].length - a[1].length);

console.log('══════════════════════════════════════════════════════════════════');
console.log('  🔍 AUDITORIA DE WRITES FINANCEIROS V1 (LEGACY)');
console.log('══════════════════════════════════════════════════════════════════');
console.log(`\nTotal: ${total} writes legados em ${sortedFiles.length} arquivos\n`);
console.log('Top arquivos:');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
for (const [file, entries] of sortedFiles.slice(0, 15)) {
  console.log(`${file}: ${entries.length}`);
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('DETALHES DOS TOP 3:\n');
for (const [file, entries] of sortedFiles.slice(0, 3)) {
  console.log(`📄 ${file} (${entries.length} writes)`);
  for (const e of entries.slice(0, 10)) {
    console.log(`   L${e.line}: ${e.code.substring(0, 80)}`);
  }
  if (entries.length > 10) {
    console.log(`   ... e mais ${entries.length - 10}`);
  }
  console.log('');
}
