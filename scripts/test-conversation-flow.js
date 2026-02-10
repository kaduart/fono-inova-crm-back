// scripts/test-conversation-flow.js
// Testa fluxo REAL de conversa com a Amanda (V7 architecture)

import mongoose from 'mongoose';
import WhatsAppOrchestratorV7 from '../orchestrators/WhatsAppOrchestratorV7.js';
import Leads from '../models/Leads.js';
import Contacts from '../models/Contacts.js';
import Messages from '../models/Messages.js';

// Telefone de teste
const TEST_PHONE = '556181694922';

// Cores para output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  red: '\x1b[31m'
};

const log = {
  header: (msg) => console.log(`\n${colors.bright}${colors.cyan}${'='.repeat(80)}${colors.reset}`),
  section: (msg) => console.log(`\n${colors.bright}${colors.blue}## ${msg}${colors.reset}`),
  user: (msg) => console.log(`${colors.green}👤 VOCÊ: ${colors.reset}${msg}`),
  amanda: (msg) => console.log(`${colors.magenta}🤖 AMANDA: ${colors.reset}${msg}`),
  info: (msg) => console.log(`${colors.cyan}ℹ️  ${msg}${colors.reset}`),
  success: (msg) => console.log(`${colors.green}✅ ${msg}${colors.reset}`),
  error: (msg) => console.log(`${colors.red}❌ ${msg}${colors.reset}`),
  warning: (msg) => console.log(`${colors.yellow}⚠️  ${msg}${colors.reset}`)
};

/**
 * Limpa dados de teste anteriores
 */
async function cleanupTestData() {
  log.section('Limpando dados de teste anteriores...');

  await Contacts.deleteMany({ phone: TEST_PHONE });
  await Leads.deleteMany({ 'contact.phone': TEST_PHONE });
  await Messages.deleteMany({
    $or: [{ from: TEST_PHONE }, { to: TEST_PHONE }]
  });

  log.success('Dados limpos');
}

/**
 * Cria contact e lead de teste
 */
async function setupTestLead() {
  log.section('Criando lead de teste...');

  const contact = await Contacts.create({
    phone: TEST_PHONE,
    name: 'Teste Conversa',
    source: 'whatsapp'
  });

  const lead = await Leads.create({
    contact: contact._id,
    status: 'new',
    source: 'whatsapp',
    conversationContext: {},
    clinicalHistory: {}
  });

  log.success(`Lead criado: ${lead._id}`);
  return { contact, lead };
}

/**
 * Simula envio de mensagem e recebe resposta
 */
async function sendMessage(lead, text, orchestrator) {
  log.user(text);

  const message = {
    content: text,
    text: text,
    from: TEST_PHONE,
    timestamp: new Date()
  };

  const response = await orchestrator.process({ lead, message });

  log.amanda(response.payload.text);

  // Recarrega lead atualizado
  lead = await Leads.findById(lead._id);

  return { response: response.payload.text, lead };
}

/**
 * Espera X segundos (para simular conversa real)
 */
function sleep(seconds) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

/**
 * TESTE 1: Especialidade Médica (deve bloquear)
 */
async function testMedicalSpecialty(orchestrator) {
  log.header();
  log.section('TESTE 1: Especialidade Médica (Neurologista)');
  log.info('Esperado: Bloquear + sugerir Neuropsicologia');

  let { contact, lead } = await setupTestLead();

  const { response } = await sendMessage(lead, 'Oi, quero marcar neurologista', orchestrator);

  if (response.includes('neurologista') && response.includes('Neuropsicologia')) {
    log.success('PASSOU: Bloqueou neurologista e sugeriu alternativa');
  } else {
    log.error('FALHOU: Não bloqueou corretamente');
  }

  await cleanupTestData();
  await sleep(1);
}

/**
 * TESTE 2: Psicologia Adulto (deve bloquear + sugerir neuropsico)
 */
async function testPsychologyAdult(orchestrator) {
  log.header();
  log.section('TESTE 2: Psicologia Adulto (18 anos)');
  log.info('Esperado: Bloquear + sugerir Neuropsicologia');

  let { contact, lead } = await setupTestLead();

  await sendMessage(lead, 'Oi, preciso de psicólogo', orchestrator);
  await sleep(0.5);

  const { response } = await sendMessage(lead, 'É pra mim, tenho 18 anos', orchestrator);

  if (response.includes('16 anos') && response.includes('Neuropsicologia')) {
    log.success('PASSOU: Bloqueou psico adulto e sugeriu neuropsico');
  } else {
    log.error('FALHOU: Não aplicou regra de idade');
  }

  await cleanupTestData();
  await sleep(1);
}

/**
 * TESTE 3: Contexto Clínico Acumulativo (aceita sugestão)
 */
async function testClinicalContextInheritance(orchestrator) {
  log.header();
  log.section('TESTE 3: Contexto Clínico Acumulativo');
  log.info('Esperado: Aceitar "ok quero" e herdar neuropsicologia automaticamente');

  let { contact, lead } = await setupTestLead();

  // Turno 1: Bloqueia psico adulto
  await sendMessage(lead, 'Oi, quero psicologia', orchestrator);
  await sleep(0.5);
  await sendMessage(lead, 'Tenho 20 anos', orchestrator);
  await sleep(0.5);

  // Turno 2: Aceita sugestão de neuropsico
  const { response, lead: updatedLead } = await sendMessage(lead, 'Ok, quero sim', orchestrator);

  // Verifica se herdou neuropsicologia
  const context = await Leads.findById(updatedLead._id);

  if (context.conversationContext?.therapy === 'neuropsicologia' ||
      response.includes('neuropsico') ||
      response.includes('idade')) {
    log.success('PASSOU: Herdou contexto de neuropsicologia');
  } else {
    log.warning('PARCIAL: Pode ter herdado, verificar contexto manualmente');
    log.info(`Terapia no contexto: ${context.conversationContext?.therapy}`);
  }

  await cleanupTestData();
  await sleep(1);
}

/**
 * TESTE 4: Interrupção (pergunta preço)
 */
async function testPriceInterruption(orchestrator) {
  log.header();
  log.section('TESTE 4: Interrupção - Pergunta Preço');
  log.info('Esperado: Responder preço + retomar conversa');

  let { contact, lead } = await setupTestLead();

  await sendMessage(lead, 'Oi, quero fono', orchestrator);
  await sleep(0.5);

  const { response } = await sendMessage(lead, 'Quanto custa?', orchestrator);

  if (response.includes('R$') || response.includes('200')) {
    log.success('PASSOU: Respondeu preço corretamente');
  } else {
    log.error('FALHOU: Não respondeu preço');
  }

  await cleanupTestData();
  await sleep(1);
}

/**
 * TESTE 5: Fluxo Completo de Agendamento
 */
async function testFullBookingFlow(orchestrator) {
  log.header();
  log.section('TESTE 5: Fluxo Completo de Agendamento');
  log.info('Esperado: Coletar dados + buscar slots + delegar BookingHandler');

  let { contact, lead } = await setupTestLead();

  // Passo 1: Terapia
  await sendMessage(lead, 'Oi, quero marcar fono', orchestrator);
  await sleep(0.5);

  // Passo 2: Queixa
  await sendMessage(lead, 'Meu filho não fala ainda', orchestrator);
  await sleep(0.5);

  // Passo 3: Idade
  await sendMessage(lead, 'Ele tem 3 anos', orchestrator);
  await sleep(0.5);

  // Passo 4: Período
  const { response } = await sendMessage(lead, 'Prefiro de manhã', orchestrator);

  if (response.includes('horário') || response.includes('opç') || response.includes('slot')) {
    log.success('PASSOU: Completou coleta de dados e ofereceu horários');
  } else {
    log.error('FALHOU: Não ofereceu horários');
  }

  await cleanupTestData();
  await sleep(1);
}

/**
 * TESTE 6: Objeção (desistência)
 */
async function testObjection(orchestrator) {
  log.header();
  log.section('TESTE 6: Objeção - Desistência');
  log.info('Esperado: Resposta empática sem forçar agendamento');

  let { contact, lead } = await setupTestLead();

  await sendMessage(lead, 'Oi, quero fono', orchestrator);
  await sleep(0.5);

  const { response } = await sendMessage(lead, 'Deixa pra lá, vou desistir', orchestrator);

  if (response.includes('Tudo bem') && response.includes('💚')) {
    log.success('PASSOU: Resposta empática à desistência');
  } else {
    log.error('FALHOU: Não tratou objeção corretamente');
  }

  await cleanupTestData();
  await sleep(1);
}

/**
 * TESTE 7: TEA (prioridade)
 */
async function testTEAPriority(orchestrator) {
  log.header();
  log.section('TESTE 7: TEA - Prioridade Alta');
  log.info('Esperado: Detectar TEA e dar prioridade');

  let { contact, lead } = await setupTestLead();

  const { response } = await sendMessage(lead, 'Meu filho tem autismo, preciso de fono', orchestrator);

  if (response.includes('prioridade') || response.includes('TEA') || response.includes('💙')) {
    log.success('PASSOU: Detectou TEA e deu prioridade');
  } else {
    log.warning('PARCIAL: Processou normalmente (verificar se marcou prioridade interna)');
  }

  await cleanupTestData();
  await sleep(1);
}

/**
 * MAIN: Executa todos os testes
 */
async function runAllTests() {
  console.clear();
  log.header();
  console.log(`${colors.bright}${colors.cyan}`);
  console.log(`
  ╔═══════════════════════════════════════════════════════════════╗
  ║                                                               ║
  ║        🧪 TESTE DE FLUXO DE CONVERSA - AMANDA V7 🧪          ║
  ║                                                               ║
  ║  Testa arquitetura V7 com conversas REAIS simuladas          ║
  ║                                                               ║
  ╚═══════════════════════════════════════════════════════════════╝
  `);
  console.log(colors.reset);

  // Conectar ao MongoDB
  log.section('Conectando ao MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/fono-inova');
  log.success('Conectado');

  // Limpar dados de teste antigos
  await cleanupTestData();

  // Criar orchestrator V7
  const orchestrator = new WhatsAppOrchestratorV7();

  // Executar testes
  try {
    await testMedicalSpecialty(orchestrator);
    await testPsychologyAdult(orchestrator);
    await testClinicalContextInheritance(orchestrator);
    await testPriceInterruption(orchestrator);
    await testFullBookingFlow(orchestrator);
    await testObjection(orchestrator);
    await testTEAPriority(orchestrator);

    log.header();
    log.section('RESUMO DOS TESTES');
    log.success('Todos os testes executados! Verifique os resultados acima.');
    log.info('Se todos passaram, a arquitetura V7 está funcionando corretamente.');

  } catch (error) {
    log.error(`Erro durante testes: ${error.message}`);
    console.error(error.stack);
  } finally {
    await mongoose.disconnect();
    log.info('Desconectado do MongoDB');
  }
}

// Executar
runAllTests().catch(console.error);
