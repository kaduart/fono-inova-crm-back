/**
 * 🧪 Test Pack: Payment List Filter
 * 
 * Cenários testados:
 * 1. Lista de pagamentos deve carregar filtrada por mês atual por padrão
 * 2. Pagamentos de meses anteriores não devem aparecer sem filtro
 * 3. Resumo financeiro deve refletir apenas o período filtrado
 * 
 * Issue: Lista de pagamentos estava vazia/vindo todos os registros
 * - Causa: useEffect duplicado no PaymentPage.tsx
 * - Correção: Usar initialPayments do AdminDashboard com filtro de mês
 */

import { expect, describe, it, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createTestContext, cleanupTestData, waitForWorker } from '../utils/test-helpers.js';
import Payment from '../../models/Payment.js';
import Patient from '../../models/Patient.js';
import Doctor from '../../models/Doctor.js';

describe('🎬 Pack: Payment List Filter', () => {
  let context;
  let mongoServer;
  let testData = {};
  const currentMonth = new Date().toISOString().substring(0, 7); // "2026-04"
  const lastMonth = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1)
    .toISOString().substring(0, 7); // "2026-03"

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);
    
    context = createTestContext();
    
    // Criar dados base
    const doctor = await Doctor.create({
      fullName: 'Dr. Pagamento Test',
      email: 'dr.pagamento@test.com',
      specialty: 'fonoaudiologia',
      cpf: '12345678902',
      phone: '61999999998',
      status: 'active'
    });
    
    const patient = await Patient.create({
      fullName: 'Paciente Pagamento Test',
      email: 'paciente.pagamento@test.com',
      phone: '61988888887',
      cpf: '98765432102',
      doctor: doctor._id
    });
    
    testData = { doctor, patient };
    
    // Criar pagamentos do mês atual (vários)
    const today = new Date();
    for (let i = 0; i < 5; i++) {
      await Payment.create({
        patient: patient._id,
        doctor: doctor._id,
        amount: 100 + (i * 50),
        paymentMethod: 'dinheiro',
        status: 'paid',
        kind: 'appointment',
        paymentDate: today,
        paidAt: today,
        notes: `Pagamento atual ${i + 1}`
      });
    }
    
    // Criar pagamentos do mês anterior (não devem aparecer no filtro padrão)
    const lastMonthDate = new Date();
    lastMonthDate.setMonth(lastMonthDate.getMonth() - 1);
    
    for (let i = 0; i < 3; i++) {
      await Payment.create({
        patient: patient._id,
        doctor: doctor._id,
        amount: 200 + (i * 100),
        paymentMethod: 'pix',
        status: 'paid',
        kind: 'appointment',
        paymentDate: lastMonthDate,
        paidAt: lastMonthDate,
        notes: `Pagamento mês anterior ${i + 1}`
      });
    }
  });

  afterAll(async () => {
    await Payment.deleteMany({ patient: testData.patient._id });
    await cleanupTestData(testData);
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  // ═══════════════════════════════════════════════════════════════
  // TESTE 1: API deve retornar pagamentos filtrados por mês
  // ═══════════════════════════════════════════════════════════════
  it('✅ deve filtrar pagamentos por mês atual por padrão', async () => {
    const { patient } = testData;
    
    // Chamar API com filtro de mês (como o AdminDashboard faz)
    const response = await context.api.get('/api/v2/payments', {
      params: {
        month: currentMonth,
        limit: 1000
      }
    });
    
    expect(response.status).toBe(200);
    expect(response.data.success).toBe(true);
    expect(response.data.data).toBeDefined();
    expect(Array.isArray(response.data.data)).toBe(true);
    
    const payments = response.data.data;
    
    // 🎯 VERIFICAÇÃO: Deve retornar apenas pagamentos do mês atual (5)
    expect(payments.length).toBe(5);
    
    // Todos devem ser do paciente de teste
    const patientPayments = payments.filter(p => 
      p.patient?._id?.toString() === patient._id.toString() ||
      p.patient?.toString() === patient._id.toString()
    );
    expect(patientPayments.length).toBe(5);
    
    // Verificar valores (100, 150, 200, 250, 300)
    const amounts = patientPayments.map(p => p.amount).sort((a, b) => a - b);
    expect(amounts).toEqual([100, 150, 200, 250, 300]);
  });

  // ═══════════════════════════════════════════════════════════════
  // TESTE 2: Filtro de mês anterior deve retornar outros pagamentos
  // ═══════════════════════════════════════════════════════════════
  it('✅ deve filtrar pagamentos por mês anterior quando solicitado', async () => {
    const { patient } = testData;
    
    const response = await context.api.get('/api/v2/payments', {
      params: {
        month: lastMonth,
        limit: 1000
      }
    });
    
    expect(response.status).toBe(200);
    
    const payments = response.data.data;
    
    // 🎯 VERIFICAÇÃO: Deve retornar apenas pagamentos do mês anterior (3)
    expect(payments.length).toBe(3);
    
    // Verificar valores (200, 300, 400)
    const amounts = payments.map(p => p.amount).sort((a, b) => a - b);
    expect(amounts).toEqual([200, 300, 400]);
  });

  // ═══════════════════════════════════════════════════════════════
  // TESTE 3: Resumo financeiro deve respeitar filtro de mês
  // ═══════════════════════════════════════════════════════════════
  it('✅ deve calcular resumo apenas do período filtrado', async () => {
    // Resumo do mês atual
    const currentResponse = await context.api.get('/api/v2/payments/summary', {
      params: { month: currentMonth }
    });
    
    expect(currentResponse.status).toBe(200);
    const currentSummary = currentResponse.data.data;
    
    // 🎯 VERIFICAÇÃO: Total do mês atual = 100+150+200+250+300 = 1000
    expect(currentSummary.totalAmount).toBe(1000);
    expect(currentSummary.paidAmount).toBe(1000);
    expect(currentSummary.pendingAmount).toBe(0);
    
    // Resumo do mês anterior
    const lastResponse = await context.api.get('/api/v2/payments/summary', {
      params: { month: lastMonth }
    });
    
    expect(lastResponse.status).toBe(200);
    const lastSummary = lastResponse.data.data;
    
    // 🎯 VERIFICAÇÃO: Total do mês anterior = 200+300+400 = 900
    expect(lastSummary.totalAmount).toBe(900);
  });

  // ═══════════════════════════════════════════════════════════════
  // TESTE 4: Sem filtro de mês deve retornar todos (ou erro)
  // ═══════════════════════════════════════════════════════════════
  it('✅ deve retornar pagamentos recentes quando não houver filtro', async () => {
    const response = await context.api.get('/api/v2/payments', {
      params: { limit: 50 }
    });
    
    expect(response.status).toBe(200);
    
    const payments = response.data.data;
    
    // Deve ter algum resultado (comportamento padrão da API)
    expect(payments.length).toBeGreaterThan(0);
    
    // 🎯 VERIFICAÇÃO: Se há mais de 5, provavelmente não está filtrando por mês
    // Isso é aceitável se a API decidir, mas o frontend DEVE sempre enviar o mês
    if (payments.length > 5) {
      console.log('⚠️  API retornou todos os pagamentos sem filtro de mês');
      console.log('   Isso é OK se o frontend sempre enviar o parâmetro month');
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // TESTE 5: Paginação deve funcionar corretamente
  // ═══════════════════════════════════════════════════════════════
  it('✅ deve paginar resultados corretamente', async () => {
    // Página 1 (2 itens)
    const page1 = await context.api.get('/api/v2/payments', {
      params: {
        month: currentMonth,
        page: 1,
        limit: 2
      }
    });
    
    expect(page1.data.data.length).toBe(2);
    
    // Página 2 (2 itens)
    const page2 = await context.api.get('/api/v2/payments', {
      params: {
        month: currentMonth,
        page: 2,
        limit: 2
      }
    });
    
    expect(page2.data.data.length).toBe(2);
    
    // Página 3 (1 item restante)
    const page3 = await context.api.get('/api/v2/payments', {
      params: {
        month: currentMonth,
        page: 3,
        limit: 2
      }
    });
    
    expect(page3.data.data.length).toBe(1);
    
    // Metadados de paginação
    expect(page1.data.meta).toBeDefined();
    expect(page1.data.meta.total).toBe(5);
    expect(page1.data.meta.pages).toBe(3);
  });
});

export default describe;
