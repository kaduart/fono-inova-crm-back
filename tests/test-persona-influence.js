#!/usr/bin/env node
/**
 * 🎭 TESTE DE INFLUÊNCIA DA PERSONA
 * 
 * Compara respostas da Amanda COM e SEM contexto de persona
 * para verificar se a classificação está de fato influenciando o tom.
 */

import mongoose from 'mongoose';
import { getOptimizedAmandaResponse } from '../orchestrators/AmandaOrchestrator.js';
import dotenv from 'dotenv';
dotenv.config();

const MONGO_URI = process.env.MONGO_URI;

// ═══════════════════════════════════════════════════════════
// CENÁRIOS DE TESTE COMPARATIVO
// ═══════════════════════════════════════════════════════════

const TESTES = [
  {
    id: 'COMP-01',
    nome: 'Lead Quente (Fechadora) vs Lead Frio (Educadora)',
    mensagem: 'Quero agendar uma avaliação para meu filho',
    leadBase: {
      name: 'Mãe Teste',
      patientInfo: { fullName: 'Pedro', age: 5 },
      therapyArea: 'fonoaudiologia'
    },
    variacoes: [
      {
        nome: 'Lead QUENTE',
        contexto: {
          stage: 'interessado_agendamento',
          messageCount: 8,
          inteligencia: {
            classificacao: {
              dor_principal: 'atraso_fala_comunicacao',
              estagio: 'quente',
              emocao: 'decidido',
              intencao: 'agendar',
              objecao: null
            },
            persona: {
              nome: 'Fechadora',
              instrucao: 'Seja direta e gentil. Conduza para agendamento com clareza. Elimine atritos.'
            }
          }
        }
      },
      {
        nome: 'Lead FRIO',
        contexto: {
          stage: 'novo',
          messageCount: 1,
          inteligencia: {
            classificacao: {
              dor_principal: 'atraso_fala_comunicacao',
              estagio: 'frio',
              emocao: 'curioso',
              intencao: 'informacao',
              objecao: null
            },
            persona: {
              nome: 'Educadora',
              instrucao: 'Explique de forma leve, sem pressionar. Gere curiosidade. Use exemplos do dia a dia.'
            }
          }
        }
      },
      {
        nome: 'Lead com OBJEÇÃO (Fase)',
        contexto: {
          stage: 'consideracao',
          messageCount: 3,
          inteligencia: {
            classificacao: {
              dor_principal: 'atraso_fala_comunicacao',
              estagio: 'consideracao',
              emocao: 'duvidoso',
              intencao: 'validar',
              objecao: 'fase'
            },
            persona: {
              nome: 'Quebradora',
              instrucao: 'Valide primeiro ("entendo a preocupação"), depois corrija a crença com dados concretos e cuidado.'
            }
          }
        }
      }
    ]
  },
  {
    id: 'COMP-02',
    nome: 'Preocupação Emocional (Validadora)',
    mensagem: 'Meu filho não fala e eu estou desesperada',
    leadBase: {
      name: 'Mãe Ansiosa',
      patientInfo: { age: 3 }
    },
    variacoes: [
      {
        nome: 'COM Persona Validadora',
        contexto: {
          stage: 'novo',
          messageCount: 1,
          inteligencia: {
            classificacao: {
              dor_principal: 'atraso_fala_comunicacao',
              estagio: 'frio',
              emocao: 'preocupado',
              intencao: 'informacao',
              objecao: null
            },
            persona: {
              nome: 'Validadora',
              instrucao: 'Acolha profundamente. Não minimize. Demonstre que entende a urgência emocional.'
            }
          }
        }
      },
      {
        nome: 'SEM Persona (controle)',
        contexto: {
          stage: 'novo',
          messageCount: 1
          // sem inteligencia
        }
      }
    ]
  }
];

// ═══════════════════════════════════════════════════════════
// FUNÇÕES AUXILIARES
// ═══════════════════════════════════════════════════════════

function analisarResposta(resposta, personaNome) {
  const analise = {
    persona: personaNome,
    tamanho: resposta.length,
    temPergunta: /\?/.test(resposta),
    temEmojiCoracao: /💚/.test(resposta),
    temCtaAgendamento: /agendar|marcar|vaga|horário|disponível/i.test(resposta),
    temValidacaoEmocional: /entendo|sei como|deve ser difícil|preocupação/i.test(resposta),
    tom: 'neutro'
  };
  
  // Análise de tom baseada em padrões
  if (/agendar|marcar|confirmar|fechar/i.test(resposta) && resposta.length < 150) {
    analise.tom = 'direto/objetivo';
  } else if (/entendo|preocupação|calma|tranquila/i.test(resposta)) {
    analise.tom = 'acolhedor';
  } else if (/exemplo|costuma|normalmente|muitas mães/i.test(resposta)) {
    analise.tom = 'educativo';
  }
  
  return analise;
}

// ═══════════════════════════════════════════════════════════
// EXECUÇÃO DOS TESTES
// ═══════════════════════════════════════════════════════════

async function rodarTeste() {
  console.log('\n══════════════════════════════════════════════════════════════════════');
  console.log(' 🎭 TESTE DE INFLUÊNCIA DA PERSONA');
  console.log('══════════════════════════════════════════════════════════════════════\n');
  
  try {
    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');
    
    const resultados = [];
    
    for (const teste of TESTES) {
      console.log(`\n${'═'.repeat(70)}`);
      console.log(`📌 ${teste.id}: ${teste.nome}`);
      console.log(`👤 Mensagem: "${teste.mensagem}"`);
      console.log(`${'═'.repeat(70)}\n`);
      
      const respostasComparacao = [];
      
      for (const variacao of teste.variacoes) {
        console.log(`\n🎭 ${variacao.nome}`);
        console.log(`   Estágio: ${variacao.contexto.stage} | Msgs: ${variacao.contexto.messageCount}`);
        if (variacao.contexto.inteligencia) {
          console.log(`   Persona: ${variacao.contexto.inteligencia.persona.nome}`);
        } else {
          console.log(`   Persona: (nenhuma - controle)`);
        }
        
        try {
          const resposta = await getOptimizedAmandaResponse({
            content: teste.mensagem,
            userText: teste.mensagem,
            lead: teste.leadBase,
            context: variacao.contexto
          });
          
          const analise = analisarResposta(resposta, variacao.nome);
          respostasComparacao.push({
            variacao: variacao.nome,
            resposta,
            analise
          });
          
          console.log(`\n   🤖 Resposta:`);
          console.log(`   "${resposta.substring(0, 120)}${resposta.length > 120 ? '...' : ''}"`);
          console.log(`   📊 Tom: ${analise.tom} | CTA: ${analise.temCtaAgendamento ? 'SIM' : 'NÃO'} | Validação: ${analise.temValidacaoEmocional ? 'SIM' : 'NÃO'}`);
          
        } catch (err) {
          console.log(`   ❌ ERRO: ${err.message}`);
          respostasComparacao.push({
            variacao: variacao.nome,
            erro: err.message
          });
        }
      }
      
      resultados.push({
        teste: teste.id,
        nome: teste.nome,
        comparacoes: respostasComparacao
      });
    }
    
    // RELATÓRIO FINAL
    console.log('\n\n' + '═'.repeat(70));
    console.log(' 📊 RELATÓRIO DE INFLUÊNCIA DA PERSONA');
    console.log('═'.repeat(70) + '\n');
    
    for (const resultado of resultados) {
      console.log(`\n📌 ${resultado.teste}: ${resultado.nome}`);
      
      const comparacoes = resultado.comparacoes.filter(c => !c.erro);
      
      if (comparacoes.length >= 2) {
        const comPersona = comparacoes.find(c => c.variacao.includes('QUENTE') || c.variacao.includes('Validadora'));
        const semPersona = comparacoes.find(c => c.variacao.includes('SEM') || c.variacao.includes('FRIO'));
        
        if (comPersona && semPersona) {
          console.log(`   Diferenças observadas:`);
          console.log(`   • Tom: ${semPersona.analise.tom} → ${comPersona.analise.tom}`);
          console.log(`   • CTA de agendamento: ${semPersona.analise.temCtaAgendamento ? 'SIM' : 'NÃO'} → ${comPersona.analise.temCtaAgendamento ? 'SIM' : 'NÃO'}`);
          console.log(`   • Validação emocional: ${semPersona.analise.temValidacaoEmocional ? 'SIM' : 'NÃO'} → ${comPersona.analise.temValidacaoEmocional ? 'SIM' : 'NÃO'}`);
          console.log(`   • Tamanho: ${semPersona.analise.tamanho} chars → ${comPersona.analise.tamanho} chars`);
          
          const influenciou = (
            semPersona.analise.tom !== comPersona.analise.tom ||
            semPersona.analise.temCtaAgendamento !== comPersona.analise.temCtaAgendamento ||
            semPersona.analise.temValidacaoEmocional !== comPersona.analise.temValidacaoEmocional
          );
          
          console.log(`   🎯 Persona INFLUENCIOU resposta: ${influenciou ? '✅ SIM' : '⚠️ NÃO CLARO'}`);
        }
      }
    }
    
    console.log('\n\n' + '═'.repeat(70));
    console.log(' ✅ TESTE CONCLUÍDO');
    console.log('═'.repeat(70) + '\n');
    
  } catch (err) {
    console.error('❌ Erro:', err);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

rodarTeste();
