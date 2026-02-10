/**
 * 🧪 VALIDADOR DE CONVERSAS REAIS
 *
 * Cole logs de conversas problemáticas aqui e veja se os fixes corrigiriam o erro.
 *
 * USO:
 * 1. Copie uma conversa problemática do production
 * 2. Cole no array CONVERSAS_PARA_TESTAR
 * 3. Execute: node backend/scripts/test-from-logs.js
 * 4. Veja se a Amanda responderia corretamente agora
 */

import WhatsAppOrchestrator from '../orchestrators/WhatsAppOrchestrator.js';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import chalk from 'chalk';

dotenv.config();

// ========================================
// CONVERSAS PROBLEMÁTICAS (COLE AQUI)
// ========================================

const CONVERSAS_PARA_TESTAR = [
  {
    id: 'TESTE-001',
    descricao: 'Cliente pergunta sobre Psicologia Infantil',
    esperado: 'NÃO deve extrair "Psicologia" como nome de paciente',
    gravidade: 'CRÍTICO', // CRÍTICO | MÉDIO | BAIXO
    mensagens: [
      { from: 'cliente', text: 'Psicologia infantil' },
      { from: 'cliente', text: 'Quanto custa?' }
    ],
    validacoes: [
      {
        tipo: 'NAO_CONTER',
        regex: /Que nome lindo.*Psicologia/i,
        erro: 'Tratou "Psicologia" como nome de paciente'
      },
      {
        tipo: 'DEVE_RESPONDER',
        mensagem: 'Deve responder sobre preço ou especialidade',
        validar: (responses) => responses.some(r => r.toLowerCase().includes('r$') || r.toLowerCase().includes('avaliação'))
      }
    ]
  },

  {
    id: 'TESTE-002',
    descricao: 'Cliente envia 2 perguntas diferentes em 3 segundos',
    esperado: 'Ambas devem ser respondidas (não bloqueadas por throttle)',
    gravidade: 'CRÍTICO',
    mensagens: [
      { from: 'cliente', text: 'Vcs atendem pela unimed?', delay: 0 },
      { from: 'cliente', text: 'Quanto custa a avaliação?', delay: 2000 }
    ],
    validacoes: [
      {
        tipo: 'QUANTIDADE_RESPOSTAS',
        minimo: 2,
        erro: 'Throttle bloqueou mensagem diferente'
      },
      {
        tipo: 'CONTER_PELO_MENOS_UMA',
        palavras: ['unimed', 'plano', 'convênio', 'particular'],
        erro: 'Não respondeu sobre plano de saúde'
      }
    ]
  },

  {
    id: 'TESTE-003',
    descricao: 'Cliente envia nome com "Jesus" no meio',
    esperado: 'Extrair nome completo, não apenas "Jesus"',
    gravidade: 'MÉDIO',
    mensagens: [
      { from: 'cliente', text: 'Yuri Jesus Bernardes Gonçalves' },
      { from: 'cliente', text: '5 anos' }
    ],
    validacoes: [
      {
        tipo: 'EXTRAIR_ENTIDADE',
        campo: 'patientName',
        valorEsperado: /Yuri Jesus/i,
        erro: 'Nome incompleto extraído'
      },
      {
        tipo: 'EXTRAIR_ENTIDADE',
        campo: 'age',
        valorEsperado: 5,
        erro: 'Idade não foi extraída'
      }
    ]
  },

  {
    id: 'TESTE-004',
    descricao: 'Cliente escreve "tãrde" com acento errado',
    esperado: 'Normalizar para "tarde" e salvar no MongoDB sem erro',
    gravidade: 'ALTO',
    mensagens: [
      { from: 'cliente', text: 'Quero marcar de tãrde' }
    ],
    validacoes: [
      {
        tipo: 'SEM_ERRO',
        erro: 'Sistema crashou com erro de MongoDB enum validation'
      },
      {
        tipo: 'EXTRAIR_ENTIDADE',
        campo: 'period',
        valorEsperado: 'tarde',
        erro: 'Período não foi normalizado corretamente'
      }
    ]
  },

  {
    id: 'TESTE-005',
    descricao: 'Cliente envia HTML malicioso',
    esperado: 'Escapar tags HTML, não executar',
    gravidade: 'CRÍTICO',
    mensagens: [
      { from: 'cliente', text: '<script>alert("xss")</script>' }
    ],
    validacoes: [
      {
        tipo: 'NAO_CONTER',
        regex: /<script>/i,
        erro: 'HTML não foi escapado (vulnerabilidade XSS)'
      },
      {
        tipo: 'CONTER',
        texto: '&lt;script&gt;',
        erro: 'HTML deveria estar escapado como &lt;...&gt;'
      }
    ]
  },

  // ========================================
  // 👇 ADICIONE SUAS CONVERSAS AQUI
  // ========================================

  /*
  {
    id: 'SEU-TESTE-001',
    descricao: 'Descreva o problema',
    esperado: 'O que deveria acontecer',
    gravidade: 'CRÍTICO', // ou 'MÉDIO' ou 'BAIXO'
    mensagens: [
      { from: 'cliente', text: 'Primeira mensagem do cliente' },
      { from: 'cliente', text: 'Segunda mensagem', delay: 2000 } // delay em ms
    ],
    validacoes: [
      {
        tipo: 'NAO_CONTER',
        regex: /texto que nao deve aparecer/i,
        erro: 'Descrição do erro'
      }
    ]
  },
  */
];

// ========================================
// EXECUTOR DE TESTES
// ========================================

async function testarConversa(teste) {
  console.log('\n' + '═'.repeat(80));
  console.log(chalk.bold.cyan(`📋 ${teste.id}: ${teste.descricao}`));
  console.log(chalk.gray(`   Gravidade: ${teste.gravidade}`));
  console.log(chalk.gray(`   Esperado: ${teste.esperado}`));
  console.log('═'.repeat(80));

  const orchestrator = new WhatsAppOrchestrator();
  const mockLead = {
    _id: new mongoose.Types.ObjectId(),
    contact: { phone: '5562999999999' },
    status: 'new',
    autoBookingContext: {}
  };

  const respostas = [];
  const entidadesExtraidas = {};
  let erro = null;

  // Simula conversa
  for (let i = 0; i < teste.mensagens.length; i++) {
    const msg = teste.mensagens[i];

    // Delay entre mensagens (para testar throttle)
    if (msg.delay) {
      console.log(chalk.gray(`   ⏳ Aguardando ${msg.delay}ms...`));
      await new Promise(r => setTimeout(r, msg.delay));
    }

    console.log(chalk.yellow(`\n   👤 Cliente: "${msg.text}"`));

    try {
      const result = await orchestrator.process({
        lead: mockLead,
        inboundMessage: { content: msg.text },
        context: mockLead.autoBookingContext
      });

      const resposta = result?.payload?.text || '(sem resposta)';
      respostas.push(resposta);

      console.log(chalk.green(`   🤖 Amanda: "${resposta.substring(0, 100)}${resposta.length > 100 ? '...' : ''}"`));

      // Captura entidades extraídas
      if (result?.context) {
        Object.assign(entidadesExtraidas, result.context.patientInfo || {});
        Object.assign(entidadesExtraidas, {
          period: result.context.period,
          therapy: result.context.therapy
        });
      }

    } catch (error) {
      erro = error;
      console.log(chalk.red(`   ❌ ERRO: ${error.message}`));
      break;
    }
  }

  // Executa validações
  console.log(chalk.bold('\n   🔍 VALIDAÇÕES:'));

  let todasPassaram = true;

  for (const validacao of teste.validacoes) {
    let passou = false;
    let mensagemErro = validacao.erro;

    try {
      switch (validacao.tipo) {
        case 'NAO_CONTER':
          passou = !respostas.some(r => validacao.regex.test(r));
          break;

        case 'CONTER':
          passou = respostas.some(r => r.includes(validacao.texto));
          break;

        case 'CONTER_PELO_MENOS_UMA':
          passou = respostas.some(r =>
            validacao.palavras.some(palavra => r.toLowerCase().includes(palavra.toLowerCase()))
          );
          break;

        case 'QUANTIDADE_RESPOSTAS':
          passou = respostas.length >= validacao.minimo;
          mensagemErro = `${validacao.erro} (recebeu ${respostas.length}, esperava >= ${validacao.minimo})`;
          break;

        case 'EXTRAIR_ENTIDADE':
          const valor = entidadesExtraidas[validacao.campo];
          if (typeof validacao.valorEsperado === 'number') {
            passou = valor == validacao.valorEsperado;
          } else if (validacao.valorEsperado instanceof RegExp) {
            passou = validacao.valorEsperado.test(valor);
          } else {
            passou = valor === validacao.valorEsperado;
          }
          mensagemErro = `${validacao.erro} (extraiu: ${valor || 'null'})`;
          break;

        case 'SEM_ERRO':
          passou = erro === null;
          mensagemErro = erro ? `${validacao.erro}: ${erro.message}` : null;
          break;

        case 'DEVE_RESPONDER':
          passou = validacao.validar(respostas);
          break;

        default:
          console.log(chalk.yellow(`   ⚠️  Tipo de validação desconhecido: ${validacao.tipo}`));
          continue;
      }

    } catch (err) {
      passou = false;
      mensagemErro = `Erro na validação: ${err.message}`;
    }

    if (passou) {
      console.log(chalk.green(`   ✅ PASSOU: ${mensagemErro || validacao.tipo}`));
    } else {
      console.log(chalk.red(`   ❌ FALHOU: ${mensagemErro}`));
      todasPassaram = false;
    }
  }

  // Resultado final do teste
  console.log('\n   ' + '─'.repeat(76));
  if (todasPassaram) {
    console.log(chalk.bold.green(`   ✅ TESTE PASSOU - Fix funcionaria!`));
  } else {
    console.log(chalk.bold.red(`   ❌ TESTE FALHOU - Ainda há problema!`));
  }

  return {
    id: teste.id,
    passou: todasPassaram,
    gravidade: teste.gravidade,
    respostas,
    entidades: entidadesExtraidas
  };
}

// ========================================
// RELATÓRIO FINAL
// ========================================

function gerarRelatorio(resultados) {
  console.log('\n\n' + '═'.repeat(80));
  console.log(chalk.bold.white('📊 RELATÓRIO FINAL DOS TESTES'));
  console.log('═'.repeat(80));

  const criticos = resultados.filter(r => r.gravidade === 'CRÍTICO');
  const criticosFalharam = criticos.filter(r => !r.passou);

  const total = resultados.length;
  const passaram = resultados.filter(r => r.passou).length;
  const falharam = total - passaram;
  const taxaSucesso = ((passaram / total) * 100).toFixed(1);

  console.log(`\n   Total de testes: ${total}`);
  console.log(chalk.green(`   ✅ Passaram: ${passaram}`));
  console.log(chalk.red(`   ❌ Falharam: ${falharam}`));
  console.log(chalk.bold(`   🎯 Taxa de sucesso: ${taxaSucesso}%`));

  if (criticosFalharam.length > 0) {
    console.log(chalk.bold.red(`\n   🚨 ATENÇÃO: ${criticosFalharam.length} bugs CRÍTICOS ainda presentes!`));
    criticosFalharam.forEach(r => {
      console.log(chalk.red(`      - ${r.id}`));
    });
    console.log(chalk.yellow('\n   ⚠️  NÃO RECOMENDADO fazer deploy até corrigir bugs críticos!'));
  } else if (falharam > 0) {
    console.log(chalk.yellow(`\n   ⚠️  Há ${falharam} bug(s) não-críticos que poderiam ser corrigidos.`));
    console.log(chalk.gray('   Deploy possível, mas recomenda-se corrigir antes.'));
  } else {
    console.log(chalk.bold.green('\n   🎉 TODOS OS TESTES PASSARAM!'));
    console.log(chalk.green('   ✅ Pronto para deploy em produção.'));
  }

  console.log('\n' + '═'.repeat(80));
}

// ========================================
// CONEXÃO E EXECUÇÃO
// ========================================

async function main() {
  console.log(chalk.bold.cyan('\n🧪 VALIDADOR DE CONVERSAS REAIS\n'));
  console.log(chalk.gray('Testando se os fixes corrigiriam os problemas reportados...\n'));

  try {
    // Conecta ao MongoDB (necessário para orchestrator)
    if (process.env.MONGO_URI) {
      await mongoose.connect(process.env.MONGO_URI, {
        useNewUrlParser: true,
        useUnifiedTopology: true
      });
      console.log(chalk.green('✅ Conectado ao MongoDB\n'));
    } else {
      console.log(chalk.yellow('⚠️  MongoDB não configurado, usando modo simulação\n'));
    }

    // Executa todos os testes
    const resultados = [];
    for (const teste of CONVERSAS_PARA_TESTAR) {
      const resultado = await testarConversa(teste);
      resultados.push(resultado);

      // Pausa entre testes
      await new Promise(r => setTimeout(r, 1000));
    }

    // Gera relatório
    gerarRelatorio(resultados);

  } catch (error) {
    console.error(chalk.red('\n❌ Erro fatal:'), error.message);
    console.error(error.stack);
  } finally {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.close();
      console.log(chalk.gray('\n👋 Conexão fechada.\n'));
    }
  }
}

// ========================================
// EXECUTAR
// ========================================

main().catch(console.error);
