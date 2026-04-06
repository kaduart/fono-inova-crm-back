/**
 * E2E V2 - Fluxo da Secretaria (Event-Driven)
 * 
 * Fluxo testado:
 * 1. Criar paciente
 * 2. Criar agendamento V2 (async) -> polling ate scheduled
 * 3. Completar atendimento V2 (async)
 * 4. Criar pagamento V2 (async) -> polling ate processed
 * 5. Verificar projecoes (Financial + Analytics)
 * 
 * Requer: servidor rodando em localhost:5000
 * Roda: npx vitest run tests/e2e/v2/fluxo-secretaria-v2.e2e.test.js
 */

import { describe, it, expect } from 'vitest';

const BASE_URL = process.env.TEST_URL || 'http://localhost:5000';
// Token atualizado - expira em 24h
const TOKEN = process.env.TEST_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4MDZkZDFiYjZmOTI1NTliNDlhOGE5YyIsInJvbGUiOiJhZG1pbiIsIm5hbWUiOiJSaWNhcmRvIE1haWEgQWRtaW4iLCJpYXQiOjE3NzU0MTExNTcsImV4cCI6MTc3NTQ5NzU1N30.y0zQItapCMMUZTLq7fRTr1euSWQP3arqlGJHQEkX0JM';

// Horario dinamico no futuro para evitar conflitos
const now = new Date();
now.setMinutes(now.getMinutes() + 5); // 5 min no futuro
const testDate = '2026-04-25';
const testTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
const sessionValue = 150.00;

const api = {
  get: (path) => fetch(`${BASE_URL}${path}`, {
    headers: { 'Authorization': `Bearer ${TOKEN}` }
  }),
  post: (path, body) => fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`
    },
    body: JSON.stringify(body)
  }),
  patch: (path, body = {}) => fetch(`${BASE_URL}${path}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`
    },
    body: JSON.stringify(body)
  })
};

const pollStatus = async (checkFn, maxAttempts = 30, interval = 1000) => {
  for (let i = 0; i < maxAttempts; i++) {
    const result = await checkFn();
    if (result.success) return { ...result, attempts: i + 1 };
    if (result.failed) return { ...result, attempts: i + 1, error: 'Failed' };
    await new Promise(r => setTimeout(r, interval));
  }
  return { success: false, error: 'TIMEOUT', attempts: maxAttempts };
};

describe('FLUXO SECRETARIA V2', () => {
  let patientId;
  let doctorId = 'test';
  let appointmentId;
  let paymentEventId;

  it('1. Deve criar paciente V2 (async)', async () => {
    const res = await api.post('/api/v2/patients', {
      fullName: `Paciente E2E ${Date.now()}`,
      phone: '11999999999',
      email: `e2e_${Date.now()}@test.com`,
      dateOfBirth: '1990-01-01'
    });
    
    const data = await res.json();
    // Patient V2 tambem eh async (202)
    expect(res.status).toBe(202);
    expect(data.success).toBe(true);
    patientId = data.data.patientId;
    console.log(`[OK] Paciente criado (async): ${patientId}`);
    
    // Aguarda processamento
    await new Promise(r => setTimeout(r, 1500));
  });

  it('2. Deve criar agendamento V2 (async)', async () => {
    // Busca um doctor real primeiro
    const doctorsRes = await api.get('/api/doctors');
    const doctorsData = await doctorsRes.json();
    let realDoctorId = doctorId;
    if (Array.isArray(doctorsData) && doctorsData.length > 0) {
      realDoctorId = doctorsData[0]._id;
    }
    
    const res = await api.post('/api/v2/appointments', {
      patientId,
      doctorId: realDoctorId,
      date: testDate,
      time: testTime,
      specialty: 'fonoaudiologia',
      serviceType: 'session',
      amount: sessionValue,
      billingType: 'particular',
      paymentMethod: 'pix',
      source: 'outro'
    });
    
    const data = await res.json();
    expect(res.status).toBe(202);
    expect(data.success).toBe(true);
    expect(data.data.appointmentId).toBeDefined();
    
    appointmentId = data.data.appointmentId;
    console.log(`[OK] Agendamento: ${appointmentId}`);
  });

  it('3. Deve fazer polling ate agendamento scheduled', async () => {
    const result = await pollStatus(async () => {
      const res = await api.get(`/api/v2/appointments/${appointmentId}/status`);
      const data = await res.json();
      
      if (data.data?.isResolved || data.data?.operationalStatus === 'scheduled') {
        return { success: true, status: data.data.operationalStatus };
      }
      if (data.data?.isRejected) {
        return { failed: true, status: data.data.operationalStatus };
      }
      return { success: false };
    }, 30, 1000);
    
    expect(result.success).toBe(true);
    expect(result.status).toBe('scheduled');
    console.log(`[OK] Scheduled em ${result.attempts} tentativas`);
  });

  it('4. Deve completar atendimento V2', async () => {
    const res = await api.patch(`/api/v2/appointments/${appointmentId}/complete`, {
      notes: 'Atendimento OK'
    });
    
    expect([200, 202]).toContain(res.status);
    const data = await res.json();
    expect(data.success).toBe(true);
    console.log('[OK] Atendimento completado');
    
    if (res.status === 202) {
      await new Promise(r => setTimeout(r, 2000));
    }
  });

  it('5. Deve criar pagamento V2 (async)', async () => {
    const res = await api.post('/api/v2/payments/request', {
      appointmentId,
      patientId,
      doctorId,
      amount: sessionValue,
      paymentMethod: 'pix',
      notes: 'E2E Test'
    });
    
    const data = await res.json();
    expect(res.status).toBe(202);
    expect(data.success).toBe(true);
    expect(data.data.eventId).toBeDefined();
    
    paymentEventId = data.data.eventId;
    console.log(`[OK] Pagamento: ${paymentEventId}`);
  });

  it('6. Deve fazer polling ate pagamento processed', async () => {
    const result = await pollStatus(async () => {
      const res = await api.get(`/api/v2/payments/status/${paymentEventId}`);
      const data = await res.json();
      
      if (data.data?.status === 'processed') {
        return { success: true, payment: data.data.payment };
      }
      if (data.data?.status === 'failed') {
        return { failed: true, error: data.data.error };
      }
      return { success: false };
    }, 30, 1000);
    
    expect(result.success).toBe(true);
    expect(result.payment).toBeDefined();
    console.log(`[OK] Pagamento processado em ${result.attempts} tentativas`);
  });

  it('7. Deve verificar Financial Overview V2', async () => {
    await new Promise(r => setTimeout(r, 1000));
    
    const res = await api.get(`/api/v2/financial/overview?date=${testDate}`);
    const data = await res.json();
    
    expect(res.status).toBe(200);
    expect(data.data).toBeDefined();
    console.log(`[OK] Financial: R$ ${data.data.revenue?.totalReceived || 0}`);
  });

  it('8. Deve verificar Analytics V2', async () => {
    const res = await api.get(`/api/v2/analytics/operational?date=${testDate}`);
    const data = await res.json();
    
    expect(res.status).toBe(200);
    expect(data.data.appointments.completed).toBeGreaterThanOrEqual(1);
    console.log(`[OK] Analytics: ${data.data.appointments.completed} completados`);
  });
});
