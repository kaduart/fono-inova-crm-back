#!/usr/bin/env node
/**
 * 🔄 Atualiza Amanda com base em casos reais
 * 
 * Script para rodar após análise de conversas:
 * node scripts/update-from-real-cases.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🔄 Atualizando Amanda com aprendizado de casos reais...\n');

// Lê sugestões geradas
const suggestionsPath = path.join(__dirname, '../test-suggestions.json');
if (!fs.existsSync(suggestionsPath)) {
  console.error('❌ Arquivo de sugestões não encontrado. Rode primeiro:');
  console.error('   node scripts/analyze-real-conversations.js');
  process.exit(1);
}

const suggestions = JSON.parse(fs.readFileSync(suggestionsPath, 'utf-8'));

console.log(`📊 Encontradas ${suggestions.summary.suggestedTestCases} sugestões de testes`);
console.log(`💡 ${suggestions.insights.length} insights gerados\n`);

// Atualiza config de treinamento
const configPath = path.join(__dirname, '../config/real-world-training.js');
let configContent = fs.readFileSync(configPath, 'utf-8');

// Adiciona novos padrões baseados nas falhas detectadas
const newPatterns = suggestions.testCases
  .filter(tc => tc.priority === 'HIGH')
  .map(tc => {
    const pattern = tc.examples[0]?.match(/[\w\s]+/)?.[0] || tc.type;
    return `    // ${tc.id}: ${tc.reason}\n    /${pattern.substring(0, 30).replace(/\s+/g, '\\s+')}/i,`;
  })
  .join('\n');

if (newPatterns) {
  console.log('📝 Novos padrões a adicionar:');
  console.log(newPatterns);
  console.log('\n⚠️  Revise manualmente o arquivo:');
  console.log('   backend/config/real-world-training.js');
}

// Gera novos casos de teste
const testCasesPath = path.join(__dirname, '../tests/amanda/real-world-cases.test.js');
let testContent = fs.readFileSync(testCasesPath, 'utf-8');

const newTestCases = suggestions.testCases
  .filter(tc => !testContent.includes(tc.id)) // Só os que ainda não existem
  .map(tc => `
  // ${tc.id}: ${tc.reason}
  ${tc.type.toUpperCase().replace(/-/g, '_')}_${tc.id.split('-')[1]}: {
    id: '${tc.id}',
    description: '${tc.examples[0]?.substring(0, 50) || tc.type}',
    history: [],
    currentMessage: '${tc.examples[0]?.substring(0, 80) || 'test'}',
    expected: {
      action: '${tc.type}',
      priority: '${tc.priority}'
    }
  },`)
  .join('');

if (newTestCases) {
  console.log('🧪 Novos casos de teste sugeridos:');
  console.log(newTestCases);
  console.log('\n⚠️  Adicione manualmente ao arquivo:');
  console.log('   backend/tests/amanda/real-world-cases.test.js');
}

console.log('\n✅ Análise completa!');
console.log('\n📋 Próximos passos:');
console.log('   1. Revise os padrões sugeridos');
console.log('   2. Atualize real-world-training.js');
console.log('   3. Adicione novos testes');
console.log('   4. Rode: npm test -- real-world-cases');
console.log('   5. Deploy para staging');

// Gera relatório de ação
const actionReport = {
  generatedAt: new Date().toISOString(),
  actions: [
    'Revisar padrões de FALLBACK_TRIGGERS',
    'Atualizar NOT_COMPLAINT se necessário',
    'Adicionar novos casos de teste',
    'Verificar SPECIALTY_DETECTION',
    'Testar em staging antes de produção'
  ],
  highPriorityCases: suggestions.testCases.filter(tc => tc.priority === 'HIGH')
};

const reportPath = path.join(__dirname, '../action-report.json');
fs.writeFileSync(reportPath, JSON.stringify(actionReport, null, 2));

console.log(`\n📄 Relatório de ações salvo em: ${reportPath}`);
