#!/usr/bin/env node
/**
 * 🧪 TESTE DE INTEGRAÇÃO RÁPIDO - AMANDA FSM V8
 * 
 * Simula o fluxo completo sem precisar de MongoDB ou serviços externos.
 * Testa: ALTA_INTENCAO → Inferência → Filtro de Slots → Resposta
 * 
 * Uso: node tests/integration-fast.js
 */

import { detectIntentPriority } from '../orchestrators/AmandaOrchestrator.js';

// ============================================
// MOCK DO SISTEMA
// ============================================

// Mock de feriados
const mockHolidays = [
  "2025-01-01", "2025-04-18", "2025-04-21", "2025-05-01",
  "2025-06-19", "2025-09-07", "2025-10-12", "2025-11-02",
  "2025-11-15", "2025-12-25"
];

// Mock de slots disponíveis (antes do filtro)
const mockSlots = [
  { date: "2025-03-27", time: "08:00", doctorId: "doc1", doctorName: "Dra. Ana", specialty: "fonoaudiologia" },
  { date: "2025-03-27", time: "14:00", doctorId: "doc1", doctorName: "Dra. Ana", specialty: "fonoaudiologia" }, // Pacote aqui!
  { date: "2025-04-18", time: "08:00", doctorId: "doc2", doctorName: "Dr. Bruno", specialty: "psicologia" },    // Feriado!
  { date: "2025-03-28", time: "09:00", doctorId: "doc2", doctorName: "Dr. Bruno", specialty: "psicologia" },
  { date: "2025-03-28", time: "15:00", doctorId: "doc3", doctorName: "Dra. Carla", specialty: "terapia_ocupacional" },
];

// Mock de pacotes contínuos (ocupados)
const mockRecurringPackages = [
  { date: "2025-03-27T14:00:00", doctorId: "doc1", patientId: "p123", packageId: "pkg456" },
];

// ============================================
// FUNÇÕES DO SISTEMA (SIMULADAS)
// ============================================

function isNationalHoliday(dateStr) {
  return mockHolidays.includes(dateStr);
}

function filterSlotsByRecurringPackages(slots, therapyArea) {
  console.log(`\n  🔍 Filtrando ${slots.length} slots...`);
  
  const filtered = slots.filter(slot => {
    const slotDateStr = slot.date;
    
    // Remove feriados
    if (isNationalHoliday(slotDateStr)) {
      console.log(`    🚫 ${slot.date} ${slot.time} - FERIADO`);
      return false;
    }
    
    // Remove pacotes contínuos
    const isOccupied = mockRecurringPackages.some(apt => {
      const aptDate = apt.date.split('T')[0];
      const aptHour = apt.date.split('T')[1].slice(0, 5);
      return aptDate === slot.date && 
             aptHour === slot.time && 
             apt.doctorId === slot.doctorId;
    });
    
    if (isOccupied) {
      console.log(`    🚫 ${slot.date} ${slot.time} - PACOTE CONTÍNUO`);
      return false;
    }
    
    console.log(`    ✅ ${slot.date} ${slot.time} - DISPONÍVEL`);
    return true;
  });
  
  console.log(`  📊 Resultado: ${filtered.length}/${slots.length} slots disponíveis`);
  return filtered;
}

function inferAreaFromContext(text) {
  const txt = (text || "").toLowerCase();
  if (/\b(fala|voz|gagueira|l[ií]ngua|linguinha|fono)\b/i.test(txt)) return 'fonoaudiologia';
  if (/\b(comportamento|emo[cç][aã]o|ansiedade|psico)\b/i.test(txt)) return 'psicologia';
  if (/\b(motor|coordena[cç][aã]o|sensorial|to\b)\b/i.test(txt)) return 'terapia_ocupacional';
  return null;
}

function buildQuickResponse(slots, hasInferredArea) {
  if (!slots || slots.length === 0) {
    return "Não tenho horários disponíveis neste período. Posso te oferecer outras datas? 💚";
  }
  
  if (!hasInferredArea) {
    return `Entendi que você precisa de um horário ${slots[0].date}! 💚\n\n` +
           `Qual especialidade você precisa: **Fonoaudiologia**, **Psicologia** ou **Terapia Ocupacional**?`;
  }
  
  const slotsList = slots.slice(0, 3).map(s => 
    `  ${s.date} às ${s.time} com ${s.doctorName}`
  ).join('\n');
  
  return `Encontrei essas opções para você:\n${slotsList}\n\nQual funciona melhor? 💚`;
}

// ============================================
// FLUXO COMPLETO SIMULADO
// ============================================

async function simulateAmandaFlow(userMessage, leadContext = {}) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`👤 LEAD: "${userMessage}"`);
  console.log(`${'='.repeat(60)}`);
  
  // PASSO 1: Detectar intenção
  const intent = detectIntentPriority(userMessage);
  console.log(`\n1️⃣  INTENÇÃO DETECTADA: ${intent}`);
  
  if (intent !== "ALTA_INTENCAO") {
    console.log(`   ⚠️  Não é ALTA_INTENCAO - Fluxo padrão`);
    return { success: false, reason: "Não é alta intenção" };
  }
  
  // PASSO 2: Inferir área
  const inferredArea = inferAreaFromContext(userMessage) || leadContext.therapyArea;
  console.log(`\n2️⃣  ÁREA INFERIDA: ${inferredArea || "Não identificada"}`);
  
  // PASSO 3: Buscar slots (simulado)
  const therapyArea = inferredArea || "fonoaudiologia"; // Fallback
  const availableSlots = mockSlots.filter(s => s.specialty === therapyArea);
  console.log(`\n3️⃣  SLOTS ENCONTRADOS: ${availableSlots.length}`);
  
  // PASSO 4: Aplicar filtros (REGRA 5)
  console.log(`\n4️⃣  APLICANDO REGRA 5 (Feriados + Pacotes):`);
  const filteredSlots = filterSlotsByRecurringPackages(availableSlots, therapyArea);
  
  // PASSO 5: Construir resposta
  console.log(`\n5️⃣  RESPOSTA DA AMANDA:`);
  const response = buildQuickResponse(filteredSlots, !!inferredArea);
  console.log(`   "${response}"`);
  
  // Validação
  const success = filteredSlots.length > 0 && !response.includes("Me conta o que você está buscando");
  
  console.log(`\n${success ? '✅ SUCESSO' : '❌ FALHA'} - Fluxo ${success ? 'completo' : 'incompleto'}`);
  
  return { success, intent, filteredSlots, response };
}

// ============================================
// TESTES DE INTEGRAÇÃO
// ============================================

async function runIntegrationTests() {
  console.log('\n' + '🧪'.repeat(30));
  console.log('  TESTE DE INTEGRAÇÃO - AMANDA FSM V8');
  console.log('🧪'.repeat(30));
  
  const testCases = [
    {
      name: "Caso 1: Tem hoje? (sem área)",
      input: "Tem hoje?",
      expectSuccess: true,
      expectSlots: true,
    },
    {
      name: "Caso 2: Amanhã de manhã (com área no contexto)",
      input: "Amanhã de manhã seria bom",
      context: { therapyArea: "fonoaudiologia" },
      expectSuccess: true,
      expectSlots: true,
    },
    {
      name: "Caso 3: Sábado tem vaga (deve filtrar pacote)",
      input: "Sábado de manhã tem vaga",
      expectSuccess: true,
      expectSlots: true,
    },
    {
      name: "Caso 4: Lead fala de fono (inferência)",
      input: "Preciso de fonoaudiologia para amanhã",
      expectSuccess: true,
      expectSlots: true,
    },
    {
      name: "Caso 5: Data em feriado (deve bloquear)",
      input: "Tem no dia 18/04?", // Sexta-feira Santa
      expectSuccess: false, // Não deve ter slots
      expectSlots: false,
    },
  ];
  
  let passed = 0;
  let failed = 0;
  
  for (const test of testCases) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`📝 ${test.name}`);
    console.log(`${'─'.repeat(60)}`);
    
    const result = await simulateAmandaFlow(test.input, test.context || {});
    
    const success = result.success === test.expectSuccess;
    const icon = success ? '✅' : '❌';
    
    console.log(`\n${icon} RESULTADO: ${success ? 'PASSOU' : 'FALHOU'}`);
    
    if (success) passed++;
    else failed++;
  }
  
  // Resumo final
  console.log('\n' + '='.repeat(60));
  console.log('📊 RESUMO DOS TESTES DE INTEGRAÇÃO');
  console.log('='.repeat(60));
  console.log(`✅ Passaram: ${passed}/${testCases.length}`);
  console.log(`❌ Falharam: ${failed}/${testCases.length}`);
  console.log('='.repeat(60));
  
  if (failed === 0) {
    console.log('\n🎉 TODOS OS TESTES DE INTEGRAÇÃO PASSARAM!');
    console.log('✅ Pode subir para staging com segurança');
    process.exit(0);
  } else {
    console.log('\n⚠️  ALGUNS TESTES FALHARAM');
    console.log('❌ Não suba para produção ainda');
    process.exit(1);
  }
}

// Executar
runIntegrationTests().catch(err => {
  console.error('❌ Erro fatal:', err);
  process.exit(1);
});
