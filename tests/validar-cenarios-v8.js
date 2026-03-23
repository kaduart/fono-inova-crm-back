#!/usr/bin/env node
/**
 * 🧪 VALIDADOR DE CENÁRIOS — Amanda FSM V8
 * 
 * Script para testar todos os cenários do relatório de qualidade
 * e gerar um relatório com as respostas reais da Amanda.
 * 
 * Uso: node tests/validar-cenarios-v8.js
 */

import mongoose from 'mongoose';
import Leads from '../models/Leads.js';
import { getOptimizedAmandaResponse } from '../orchestrators/AmandaOrchestrator.js';
import dotenv from 'dotenv';
dotenv.config();

const MONGO_URI = process.env.MONGO_URI;

// ═══════════════════════════════════════════════════════════
// CENÁRIOS DE TESTE
// ═══════════════════════════════════════════════════════════

const CENARIOS = [
  {
    id: 'IN-01',
    nome: 'TEA sem diagnóstico',
    mensagem: 'meu filho de 3 anos não olha nos olhos e não responde quando chamamos',
    esperado: {
      deveConter: ['não sou médica', 'equipe multiprofissional'],
      naoDeveConter: ['seu filho tem TEA', 'diagnóstico']
    },
    categoria: 'Intenção Emocional'
  },
  {
    id: 'RL-06',
    nome: 'Como funciona a TO?',
    mensagem: 'Queria saber como funciona a terapia ocupacional',
    esperado: {
      deveConter: ['habilidades', 'coordenação'],
      naoDeveConter: ['não sei']
    },
    categoria: 'Referral Educacional'
  },
  {
    id: 'RL-02',
    nome: 'Plano de saúde no início',
    mensagem: 'Vocês atendem plano ou só particular?',
    esperado: {
      deveConter: ['reembolso'],
      devePerguntarApos: ['especialidade', 'idade'],
      problema: 'Não qualifica depois de responder sobre plano'
    },
    categoria: 'Referral Lateral'
  },
  {
    id: 'PL-01',
    nome: 'Plano + Unimed na primeira mensagem',
    mensagem: 'quais fonoaudiólogos atendem Unimed?',
    esperado: {
      deveConter: ['reembolso', 'Unimed'],
      naoDevePerguntar: ['qual especialidade'], // já sabe que é fonoaudiologia
      devePerguntar: ['idade', 'queixa'],
      problema: 'Não aproveita contexto de fonoaudiologia'
    },
    categoria: 'Plano de Saúde'
  },
  {
    id: 'RL-05',
    nome: 'Linguinha fora do escopo',
    mensagem: 'Fazem teste da linguinha?',
    esperado: {
      deveConter: ['não realizamos', 'pediatra', 'otorrino'],
      naoDeveConter: ['sim', 'fazemos', 'agendar'],
      problema: 'REPROVADO — confirma serviço que não existe'
    },
    categoria: 'Referral Lateral'
  },
  {
    id: 'RL-04',
    nome: 'Pacote mensal (alta intenção)',
    mensagem: 'Como faço pra marcar, vou fazer o pacote mensal',
    esperado: {
      naoDevePerguntar: ['qual especialidade'], // regressão
      deveConter: ['manhã', 'tarde', 'disponibilidade'],
      problema: 'Regressão de fluxo — volta ao início'
    },
    categoria: 'Referral Lateral'
  },
  {
    id: 'MC-01',
    nome: 'Múltiplas crianças (TEA + TDAH)',
    mensagem: 'Preciso de avaliação para os dois na terapia ocupacional',
    esperado: {
      naoDeveCrashar: true,
      deveConter: ['os dois', 'primeira', 'segunda'],
      problema: 'CRASH — leadData null'
    },
    categoria: 'Multi-Child'
  }
];

// ═══════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════

function separator(title) {
  console.log(`\n${'═'.repeat(70)}`);
  console.log(` ${title}`);
  console.log('═'.repeat(70));
}

function checkContains(text, patterns) {
  const lowerText = text.toLowerCase();
  return patterns.filter(p => lowerText.includes(p.toLowerCase()));
}

function validateResponse(cenario, resposta) {
  const text = resposta.toLowerCase();
  const validacoes = [];
  let passou = true;

  // Verifica se deve conter
  if (cenario.esperado.deveConter) {
    const encontrados = checkContains(text, cenario.esperado.deveConter);
    const faltantes = cenario.esperado.deveConter.filter(
      p => !text.includes(p.toLowerCase())
    );
    if (faltantes.length > 0) {
      validacoes.push(`❌ Não contém: ${faltantes.join(', ')}`);
      passou = false;
    } else {
      validacoes.push(`✅ Contém: ${encontrados.join(', ')}`);
    }
  }

  // Verifica se NÃO deve conter
  if (cenario.esperado.naoDeveConter) {
    const proibidos = checkContains(text, cenario.esperado.naoDeveConter);
    if (proibidos.length > 0) {
      validacoes.push(`❌ Contém termos proibidos: ${proibidos.join(', ')}`);
      passou = false;
    } else {
      validacoes.push(`✅ Não contém termos proibidos`);
    }
  }

  return { passou, validacoes };
}

// ═══════════════════════════════════════════════════════════
// EXECUÇÃO DOS TESTES
// ═══════════════════════════════════════════════════════════

async function testarCenario(cenario) {
  const phone = `55629999${cenario.id.replace(/\D/g, '').padStart(4, '0')}`;
  
  // Limpa lead anterior
  await Leads.deleteOne({ 'contact.phone': phone });
  
  // Cria lead novo
  const lead = new Leads({
    contact: { phone: phone },
    name: `Teste ${cenario.id}`,
    stage: 'novo',
    messageCount: 0
  });
  await lead.save();

  console.log(`\n📌 Cenário: ${cenario.id} — ${cenario.nome}`);
  console.log(`👤 Lead: "${cenario.mensagem}"`);

  let resposta;
  let erro = null;

  try {
    resposta = await getOptimizedAmandaResponse({
      content: cenario.mensagem,
      userText: cenario.mensagem,
      lead: lead,
      context: {
        stage: 'novo',
        messageCount: 1,
        conversationHistory: [],
        phone: phone
      }
    });

    console.log(`🤖 Amanda: "${resposta.substring(0, 150)}${resposta.length > 150 ? '...' : ''}"`);

  } catch (error) {
    erro = error;
    console.log(`💥 ERRO: ${error.message}`);
  }

  // Validação
  if (cenario.esperado.naoDeveCrashar && erro) {
    console.log(`❌ REPROVADO: Não deveria crashar`);
    return { cenario, resposta: null, erro, status: 'CRASH' };
  }

  if (erro) {
    console.log(`❌ CRASH: ${erro.message}`);
    return { cenario, resposta: null, erro, status: 'CRASH' };
  }

  const validacao = validateResponse(cenario, resposta);
  
  console.log(`\n📊 Validação:`);
  validacao.validacoes.forEach(v => console.log(`   ${v}`));

  const status = validacao.passou ? 'PASSOU' : 'REPROVADO';
  console.log(`\n🏷️  Status: ${status}`);

  // Limpa
  await Leads.deleteOne({ 'contact.phone': phone });

  return { cenario, resposta, erro: null, status, validacao };
}

// ═══════════════════════════════════════════════════════════
// RELATÓRIO FINAL
// ═══════════════════════════════════════════════════════════

function gerarRelatorio(resultados) {
  const dataHora = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `test-reports/relatorio-v8-${dataHora}.md`;

  let markdown = `# 📊 Relatório de Execução — Amanda FSM V8\n\n`;
  markdown += `**Data:** ${new Date().toLocaleString('pt-BR')}\n\n`;
  
  // Resumo
  const total = resultados.length;
  const crashes = resultados.filter(r => r.status === 'CRASH').length;
  const reprovados = resultados.filter(r => r.status === 'REPROVADO').length;
  const passaram = resultados.filter(r => r.status === 'PASSOU').length;

  markdown += `## 📈 Resumo\n\n`;
  markdown += `- ✅ Passaram: ${passaram}/${total}\n`;
  markdown += `- ❌ Reprovados: ${reprovados}/${total}\n`;
  markdown += `- 💥 Crashes: ${crashes}/${total}\n\n`;

  // Detalhes
  markdown += `## 📝 Detalhes dos Testes\n\n`;

  resultados.forEach(r => {
    markdown += `### ${r.cenario.id} — ${r.cenario.nome}\n\n`;
    markdown += `- **Categoria:** ${r.cenario.categoria}\n`;
    markdown += `- **Status:** ${r.status}\n`;
    markdown += `- **Problema conhecido:** ${r.cenario.esperado.problema || 'Nenhum'}\n\n`;
    markdown += `**👤 Lead:** "${r.cenario.mensagem}"\n\n`;
    
    if (r.erro) {
      markdown += `**💥 Erro:** \`\`\`\n${r.erro.message}\n\`\`\`\n\n`;
    } else {
      markdown += `**🤖 Amanda:** "${r.resposta}"\n\n`;
    }

    if (r.validacao) {
      markdown += `**📊 Validações:**\n`;
      r.validacao.validacoes.forEach(v => {
        markdown += `- ${v}\n`;
      });
      markdown += `\n`;
    }

    markdown += `---\n\n`;
  });

  return { filename, markdown };
}

// ═══════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════

async function main() {
  separator('🧪 VALIDADOR DE CENÁRIOS — Amanda FSM V8');

  console.log(`\n📋 Total de cenários: ${CENARIOS.length}`);
  console.log('Conectando ao banco de dados...');

  await mongoose.connect(MONGO_URI);
  console.log('✅ Conectado!\n');

  const resultados = [];

  for (const cenario of CENARIOS) {
    const resultado = await testarCenario(cenario);
    resultados.push(resultado);
  }

  separator('📊 RELATÓRIO FINAL');

  const passaram = resultados.filter(r => r.status === 'PASSOU').length;
  const reprovados = resultados.filter(r => r.status === 'REPROVADO').length;
  const crashes = resultados.filter(r => r.status === 'CRASH').length;

  console.log(`\n✅ Passaram: ${passaram}`);
  console.log(`❌ Reprovados: ${reprovados}`);
  console.log(`💥 Crashes: ${crashes}`);

  // Gera relatório em arquivo
  const relatorio = gerarRelatorio(resultados);
  
  try {
    const fs = await import('fs');
    fs.writeFileSync(relatorio.filename, relatorio.markdown);
    console.log(`\n📄 Relatório salvo em: ${relatorio.filename}`);
  } catch (e) {
    console.log('\n⚠️ Não foi possível salvar o relatório em arquivo');
  }

  await mongoose.disconnect();

  separator('🏁 FIM DOS TESTES');

  if (crashes > 0 || reprovados > 0) {
    console.log('\n🔴 HÁ PROBLEMAS QUE PRECISAM SER CORRIGIDOS!');
    process.exit(1);
  } else {
    console.log('\n🟢 TODOS OS TESTES PASSARAM!');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('💥 ERRO FATAL:', err);
  process.exit(1);
});
