#!/usr/bin/env node
/**
 * 🔍 Analisador de Conversas Reais
 * 
 * Extrai padrões de falha e sucesso das conversas reais
 * para alimentar o aprendizado contínuo da Amanda
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 📁 Arquivos de entrada
const FILES = {
  whatsapp: path.join(__dirname, '../whatsapp_export_2025-11-26.txt'),
  historico: path.join(__dirname, '../historico-de-leads.txt')
};

// 🎯 Padrões a detectar
const PATTERNS = {
  // Falhas do sistema
  SYSTEM_FAILURES: [
    /erro/i,
    /não (entendi|entendeu|funcionou|muda|mudou)/i,
    /duplicando (a )?mensagem/i,
    /fora do ar/i,
    /bug/i
  ],

  // Cancelamentos/Desistências
  CANCELLATIONS: [
    /(cancelar|desistir|não vou conseguir|não posso)/i,
    /(não tenho dinheiro|não recebi|não posso pagar)/i,
    /(gripou|doente|doença|atrasado|imprevisto)/i,
    /(plantão extra|trabalho|não tenho quem leve)/i
  ],

  // Confusões
  CONFUSIONS: [
    /(confundiu|errei|errado|dia errado|horário errado)/i,
    /(segunda|terça|quarta|quinta|sexta).*?(segunda|terça|quarta|quinta|sexta)/i,
    /(manhã|tarde|noite).*?(manhã|tarde|noite)/i
  ],

  // Respostas curtas (ambíguas)
  SHORT_REPLIES: [
    /^\s*(ok|sim|não|ta|tá|bom|boa)\s*$/i,
    /^\s*(pode|pode sim|confirmado)\s*$/i
  ],

  // Múltiplas crianças
  MULTIPLE_CHILDREN: [
    /(dois filhos|duas crianças|dois irmãos|pedro e thiago|josé miguel e joão henrique)/i,
    /(filho de \d+ e filha de \d+|\d+ anos e \d+ anos)/i,
    /(tea|tdah|autismo).*?(tea|tdah|autismo)/i
  ],

  // Questões de plano/preco cedo
  EARLY_PRICE_QUESTION: [
    /(aceitam?|tem|fazem?).*?(plano|convênio|unimed|amil|hapvida)/i,
    /(quanto custa|qual o valor|preço).*?(primeira|início|oi|bom dia)/i
  ],

  // Pedidos específicos
  SPECIFIC_REQUESTS: [
    /(falar com|falar c|falar a|conversar com).{0,20}(vivi|viviane|mikaelly|lorrany)/i,
    /(quero|preciso de).{0,30}(declaração|comprovante|nota fiscal|relatório)/i
  ],

  // Satisfação/Retenção
  POSITIVE_FEEDBACK: [
    /(obrigada?|obrigado|agradeço|muito bom|excelente|perfeito)/i,
    /(pode confirmar|confirmado|tá bom|tá certo)/i
  ]
};

/**
 * 📊 Analisa uma conversa e extrai métricas
 */
function analyzeConversation(text, source) {
  const results = {
    source,
    totalLines: text.split('\n').length,
    patterns: {},
    examples: {}
  };

  for (const [category, regexes] of Object.entries(PATTERNS)) {
    results.patterns[category] = 0;
    results.examples[category] = [];

    for (const regex of regexes) {
      const matches = text.match(regex);
      if (matches) {
        results.patterns[category] += matches.length;
        // Salva exemplo (primeira ocorrência)
        if (results.examples[category].length < 3) {
          const context = text.substring(
            Math.max(0, text.indexOf(matches[0]) - 50),
            Math.min(text.length, text.indexOf(matches[0]) + matches[0].length + 50)
          );
          results.examples[category].push(context.replace(/\n/g, ' '));
        }
      }
    }
  }

  return results;
}

/**
 * 🎯 Extrai casos de teste sugeridos
 */
function extractTestCases(analysis) {
  const testCases = [];

  if (analysis.patterns.MULTIPLE_CHILDREN > 0) {
    testCases.push({
      id: `MC-${Date.now()}`,
      type: 'multiple_children',
      priority: 'HIGH',
      examples: analysis.examples.MULTIPLE_CHILDREN,
      reason: 'Desconto automático não detectado'
    });
  }

  if (analysis.patterns.CANCELLATIONS > 0) {
    testCases.push({
      id: `DC-${Date.now()}`,
      type: 'cancellation',
      priority: 'HIGH',
      examples: analysis.examples.CANCELLATIONS,
      reason: 'Sistema não oferece remarcação automática'
    });
  }

  if (analysis.patterns.CONFUSIONS > 0) {
    testCases.push({
      id: `CH-${Date.now()}`,
      type: 'confusion',
      priority: 'MEDIUM',
      examples: analysis.examples.CONFUSIONS,
      reason: 'Clarificação de dia/horário necessária'
    });
  }

  if (analysis.patterns.SHORT_REPLIES > 0) {
    testCases.push({
      id: `EC-${Date.now()}`,
      type: 'short_reply',
      priority: 'MEDIUM',
      examples: analysis.examples.SHORT_REPLIES,
      reason: 'Interpretação de "ok" sem contexto'
    });
  }

  if (analysis.patterns.EARLY_PRICE_QUESTION > 0) {
    testCases.push({
      id: `IF-${Date.now()}`,
      type: 'early_price',
      priority: 'HIGH',
      examples: analysis.examples.EARLY_PRICE_QUESTION,
      reason: 'Não deve salvar como complaint'
    });
  }

  return testCases;
}

/**
 * 🚀 Main
 */
async function main() {
  console.log('🔍 Analisador de Conversas Reais - Amanda AI\n');

  const allResults = [];
  const allTestCases = [];

  for (const [name, filePath] of Object.entries(FILES)) {
    if (!fs.existsSync(filePath)) {
      console.log(`⚠️ Arquivo não encontrado: ${filePath}`);
      continue;
    }

    console.log(`📁 Analisando: ${name}`);
    const content = fs.readFileSync(filePath, 'utf-8');
    
    const analysis = analyzeConversation(content, name);
    allResults.push(analysis);

    const testCases = extractTestCases(analysis);
    allTestCases.push(...testCases);

    // Print resumo
    console.log(`   Linhas: ${analysis.totalLines}`);
    console.log(`   Padrões detectados:`);
    for (const [cat, count] of Object.entries(analysis.patterns)) {
      if (count > 0) {
        console.log(`     - ${cat}: ${count}`);
      }
    }
    console.log();
  }

  // Gera relatório
  const report = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalConversations: allResults.length,
      totalPatterns: allResults.reduce((acc, r) => 
        acc + Object.values(r.patterns).reduce((a, b) => a + b, 0), 0
      ),
      suggestedTestCases: allTestCases.length
    },
    testCases: allTestCases,
    insights: generateInsights(allResults)
  };

  // Salva relatório
  const reportPath = path.join(__dirname, '../test-suggestions.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log('✅ Relatório gerado:');
  console.log(`   ${reportPath}`);
  console.log(`\n📊 Sugestões de testes: ${allTestCases.length}`);
  
  if (allTestCases.length > 0) {
    console.log('\n🎯 Prioridade ALTA:');
    allTestCases
      .filter(tc => tc.priority === 'HIGH')
      .forEach(tc => {
        console.log(`   - ${tc.id}: ${tc.type}`);
        console.log(`     ${tc.reason}`);
      });
  }
}

function generateInsights(results) {
  const insights = [];
  
  const totalCancellations = results.reduce((acc, r) => acc + r.patterns.CANCELLATIONS, 0);
  const totalConfusions = results.reduce((acc, r) => acc + r.patterns.CONFUSIONS, 0);
  const multipleChildren = results.reduce((acc, r) => acc + r.patterns.MULTIPLE_CHILDREN, 0);

  if (totalCancellations > 10) {
    insights.push(`Alta taxa de cancelamentos (${totalCancellations} ocorrências). Sugiro implementar fluxo de retenção automática.`);
  }

  if (totalConfusions > 5) {
    insights.push(`Confusão de horário frequente (${totalConfusions} ocorrências). Implementar confirmação dupla.`);
  }

  if (multipleChildren > 0) {
    insights.push(`Detectadas ${multipleChildren} conversas com múltiplas crianças. Verificar se desconto automático está funcionando.`);
  }

  return insights;
}

main().catch(console.error);
