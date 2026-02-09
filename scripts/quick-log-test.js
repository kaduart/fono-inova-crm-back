/**
 * ⚡ TESTE RÁPIDO COM LOGS (FORMATO LIVRE)
 *
 * Cole logs de conversas em QUALQUER FORMATO e teste rapidamente.
 *
 * USO RÁPIDO:
 * 1. Cole a conversa na seção LOGS_PARA_TESTAR abaixo
 * 2. Execute: node backend/scripts/quick-log-test.js
 * 3. Veja se Amanda responderia corretamente
 */

import WhatsAppOrchestratorV7 from '../orchestrators/WhatsAppOrchestratorV7.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

// ========================================
// 👇 COLE SEUS LOGS AQUI (FORMATO LIVRE)
// ========================================

const LOGS_PARA_TESTAR = `

CONVERSA REAL DE PRODUÇÃO (2026-02-09 17:52):

Cliente: Olá! Vi o site e gostaria de agendar uma avaliação.
Cliente: Neurologista
Cliente: Pra ver o desenho do meu filho
Cliente: Desenvolvimento neuro

PROBLEMA: Amanda extraiu "Neurologista" como nome e disse "Que nome lindo, Neurologista! 🥰"
ESPERADO: NÃO deve tratar "Neurologista" como nome de paciente

`;

// OU formato simples:
/*
const LOGS_PARA_TESTAR = `
Vcs atendem pela unimed?
Quanto custa a avaliação?
`;
*/

// OU formato de log do sistema:
/*
const LOGS_PARA_TESTAR = `
[11:30] Cliente (5562999999999): Oi
[11:31] Amanda: Oi! Como posso ajudar? 😊
[11:32] Cliente: Psicologia infantil
[11:32] Amanda: Que nome lindo, Psicologia Infantil!
`;
*/

// ========================================
// PARSER INTELIGENTE DE LOGS
// ========================================

function parseLog(logText) {
  const mensagens = [];
  const linhas = logText.split('\n').map(l => l.trim()).filter(l => l);

  for (const linha of linhas) {
    // Ignora linhas de comentário ou descrição
    if (linha.startsWith('//') ||
        linha.startsWith('PROBLEMA:') ||
        linha.startsWith('ESPERADO:') ||
        linha.startsWith('CONVERSA') ||
        linha.startsWith('===') ||
        linha.startsWith('---')) {
      continue;
    }

    // Formato: "Cliente: mensagem" ou "Amanda: mensagem"
    let match = linha.match(/^(Cliente|Amanda):\s*(.+)$/i);
    if (match) {
      const [, remetente, texto] = match;
      if (remetente.toLowerCase() === 'cliente') {
        mensagens.push(texto);
      }
      continue;
    }

    // Formato: "[HH:MM] Cliente (numero): mensagem"
    match = linha.match(/^\[[\d:]+\]\s*(Cliente|Amanda)(?:\s*\([\d]+\))?:\s*(.+)$/i);
    if (match) {
      const [, remetente, texto] = match;
      if (remetente.toLowerCase() === 'cliente') {
        mensagens.push(texto);
      }
      continue;
    }

    // Formato: "👤 Cliente: mensagem" (com emoji)
    match = linha.match(/^👤\s*Cliente:\s*"?(.+?)"?$/i);
    if (match) {
      mensagens.push(match[1]);
      continue;
    }

    // Formato: linha simples (assume que é mensagem do cliente)
    if (!linha.includes('Amanda') && !linha.includes('🤖')) {
      mensagens.push(linha);
    }
  }

  return mensagens;
}

// ========================================
// EXECUTOR DE TESTE
// ========================================

async function testarConversaRapida(mensagens) {
  console.log('\n🧪 TESTANDO CONVERSA\n');
  console.log('═'.repeat(80));
  console.log('📝 Mensagens extraídas do log:\n');

  mensagens.forEach((msg, i) => {
    console.log(`   ${i + 1}. "${msg}"`);
  });

  console.log('═'.repeat(80));

  const orchestrator = new WhatsAppOrchestratorV7();
  const mockLead = {
    _id: new mongoose.Types.ObjectId(),
    contact: { phone: '5562999999999' },
    status: 'new',
    autoBookingContext: {}
  };

  console.log('\n🔄 Processando com Amanda...\n');

  const respostas = [];
  let contexto = {};

  for (let i = 0; i < mensagens.length; i++) {
    const mensagem = mensagens[i];

    console.log(`\n   👤 Cliente: "${mensagem}"`);

    try {
      const result = await orchestrator.process({
        lead: mockLead,
        inboundMessage: { content: mensagem },
        context: contexto
      });

      const resposta = result?.payload?.text || '(sem resposta)';
      respostas.push(resposta);

      console.log(`   🤖 Amanda: "${resposta.substring(0, 150)}${resposta.length > 150 ? '...' : ''}"`);

      // Atualiza contexto
      if (result?.context) {
        contexto = { ...contexto, ...result.context };
      }

    } catch (error) {
      console.log(`   ❌ ERRO: ${error.message}`);
      break;
    }
  }

  console.log('\n' + '═'.repeat(80));

  // Análise rápida
  console.log('\n📊 ANÁLISE RÁPIDA:\n');

  const problemas = [];

  // Verifica se tratou termo médico como nome
  if (respostas.some(r => r.match(/Que nome lindo.*(Psicologia|Pediatra|Fono|Fisio)/i))) {
    problemas.push('❌ Tratou termo médico como nome de paciente');
  } else if (mensagens.some(m => m.match(/psicologia|pediatra|fono|fisio/i))) {
    console.log('   ✅ Termos médicos NÃO foram tratados como nome');
  }

  // Verifica se respondeu todas as mensagens
  if (respostas.length < mensagens.length) {
    problemas.push(`❌ Não respondeu todas as mensagens (${respostas.length}/${mensagens.length})`);
  } else {
    console.log(`   ✅ Respondeu todas as ${mensagens.length} mensagens`);
  }

  // Verifica se repetiu saudação
  const saudacoes = respostas.filter(r => r.match(/^(Oi|Olá|Opa)/i));
  if (saudacoes.length > 1) {
    problemas.push('❌ Repetiu saudação múltiplas vezes');
  }

  // Verifica se há HTML não escapado (XSS)
  if (mensagens.some(m => m.includes('<script>')) &&
      respostas.some(r => r.includes('<script>'))) {
    problemas.push('❌ HTML malicioso não foi escapado (vulnerabilidade XSS)');
  }

  // Mostra problemas
  if (problemas.length > 0) {
    console.log('\n   🚨 PROBLEMAS DETECTADOS:\n');
    problemas.forEach(p => console.log(`   ${p}`));
    console.log('\n   ⚠️  Há problemas que precisam ser corrigidos!');
  } else {
    console.log('\n   ✅ Nenhum problema óbvio detectado!');
  }

  console.log('\n' + '═'.repeat(80));

  // Mostra contexto extraído
  if (Object.keys(contexto).length > 0) {
    console.log('\n📋 CONTEXTO EXTRAÍDO:\n');
    console.log(`   Nome: ${contexto.patientInfo?.fullName || '(não extraído)'}`);
    console.log(`   Idade: ${contexto.patientInfo?.age || '(não extraído)'}`);
    console.log(`   Terapia: ${contexto.therapy || '(não extraído)'}`);
    console.log(`   Período: ${contexto.period || '(não extraído)'}`);
    console.log('\n' + '═'.repeat(80));
  }

  return {
    mensagens,
    respostas,
    contexto,
    problemas
  };
}

// ========================================
// MAIN
// ========================================

async function main() {
  console.log('\n⚡ TESTE RÁPIDO COM LOGS\n');

  try {
    // Conecta ao MongoDB (se disponível)
    if (process.env.MONGO_URI) {
      await mongoose.connect(process.env.MONGO_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true
      });
      console.log('✅ Conectado ao MongoDB\n');
    } else {
      console.log('⚠️  MongoDB não configurado, usando modo simulação\n');
    }

    // Parse dos logs
    const mensagens = parseLog(LOGS_PARA_TESTAR);

    if (mensagens.length === 0) {
      console.log('❌ Nenhuma mensagem de cliente encontrada no log!');
      console.log('\nDica: Cole o log na variável LOGS_PARA_TESTAR no topo do arquivo.\n');
      console.log('Formatos aceitos:');
      console.log('  - "Cliente: mensagem"');
      console.log('  - "[11:30] Cliente: mensagem"');
      console.log('  - "mensagem" (linhas simples)\n');
      return;
    }

    // Executa teste
    const resultado = await testarConversaRapida(mensagens);

    // Resultado final
    console.log('\n🎯 RESULTADO FINAL:\n');

    if (resultado.problemas.length === 0) {
      console.log('   ✅ TESTE PASSOU! Amanda responderia corretamente.');
      console.log('   🚀 Pronto para deploy em produção.\n');
    } else {
      console.log(`   ❌ TESTE FALHOU! Há ${resultado.problemas.length} problema(s).`);
      console.log('   ⚠️  Corrija antes de fazer deploy.\n');
    }

  } catch (error) {
    console.error('\n❌ Erro fatal:', error.message);
    console.error(error.stack);
  } finally {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
      console.log('👋 Conexão fechada.\n');
    }
  }
}

// ========================================
// EXECUTAR
// ========================================

main().catch(console.error);
