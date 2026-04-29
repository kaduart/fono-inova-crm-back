/**
 * Financial Feature Flag — Integration Tests
 *
 * Valida que o header X-Financial-Version altera o comportamento real da API.
 * Roda contra servidor local (localhost:5000) com FF_FINANCIAL_LEDGER=true.
 *
 * Pré-condição: servidor rodando com FF_FINANCIAL_LEDGER=true
 */

const BASE_URL = 'http://localhost:5000';
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY5YzdmYjMxNzhkY2MxNzI0MWQ2ODQ0OCIsImVtYWlsIjoiY2xpbmljYWZvbm9pbm92YUBnbWFpbC5jb20iLCJyb2xlIjoiYWRtaW4iLCJpYXQiOjE3NzQ5NzIwNTEsImV4cCI6MTc3NDk5MDA1MX0.2u6khP8juFAo3AVuVNdoq2rIkBz0Ffrntps-aX3CM1c';

async function fetchAppointments(financialVersion) {
  const today = new Date().toISOString().split('T')[0];
  const headers = {
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  };
  if (financialVersion) {
    headers['X-Financial-Version'] = financialVersion;
  }

  const res = await fetch(`${BASE_URL}/api/v2/appointments?date=${today}&limit=3`, { headers });
  return res.json();
}

async function fetchSingleAppointment(id, financialVersion) {
  const headers = {
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
  };
  if (financialVersion) {
    headers['X-Financial-Version'] = financialVersion;
  }

  const res = await fetch(`${BASE_URL}/api/v2/appointments/${id}`, { headers });
  return res.json();
}

describe('Financial Feature Flag — API integration', () => {
  let sampleAppointmentId;

  beforeAll(async () => {
    const data = await fetchAppointments();
    const appts = data?.appointments || data?.data?.appointments || [];
    sampleAppointmentId = appts[0]?._id;
  });

  // ─── Lista de agendamentos ───────────────────────────────────────────────

  describe('GET /api/v2/appointments (lista)', () => {
    it('V1: não inclui _financialSource nos items', async () => {
      const data = await fetchAppointments('v1');
      const appts = data?.appointments || data?.data?.appointments || [];

      for (const a of appts) {
        expect(a._financialSource).toBeUndefined();
      }
    });

    it('V2: inclui _financialSource nos items', async () => {
      const data = await fetchAppointments('v2');
      const appts = data?.appointments || data?.data?.appointments || [];
      // Pode ter 0 agendamentos hoje — só valida se tiver
      for (const a of appts) {
        expect(a._financialSource).toBeDefined();
      }
    });

    it('sem header (default) retorna V1 (sem _financialSource)', async () => {
      const data = await fetchAppointments(null);
      const appts = data?.appointments || data?.data?.appointments || [];
      for (const a of appts) {
        expect(a._financialSource).toBeUndefined();
      }
    });

    it('dual: inclui _financialSource (ledger ativo)', async () => {
      const data = await fetchAppointments('dual');
      const appts = data?.appointments || data?.data?.appointments || [];
      for (const a of appts) {
        expect(a._financialSource).toBeDefined();
      }
    });
  });

  // ─── Agendamento único ───────────────────────────────────────────────────

  describe('GET /api/v2/appointments/:id (single)', () => {
    it('V1: não inclui _financialSource', async () => {
      if (!sampleAppointmentId) return;
      const data = await fetchSingleAppointment(sampleAppointmentId, 'v1');
      const appt = data?.appointment || data?.data?.appointment;
      expect(appt._financialSource).toBeUndefined();
    });

    it('V2: inclui _financialSource', async () => {
      if (!sampleAppointmentId) return;
      const data = await fetchSingleAppointment(sampleAppointmentId, 'v2');
      const appt = data?.appointment || data?.data?.appointment;
      expect(appt._financialSource).toBeDefined();
    });

    it('V1 e V2 retornam mesmo _id', async () => {
      if (!sampleAppointmentId) return;
      const [v1, v2] = await Promise.all([
        fetchSingleAppointment(sampleAppointmentId, 'v1'),
        fetchSingleAppointment(sampleAppointmentId, 'v2'),
      ]);
      const a1 = v1?.appointment || v1?.data?.appointment;
      const a2 = v2?.appointment || v2?.data?.appointment;
      expect(a1._id).toBe(a2._id);
    });

    it('header inválido cai para V1', async () => {
      if (!sampleAppointmentId) return;
      const data = await fetchSingleAppointment(sampleAppointmentId, 'v99');
      const appt = data?.appointment || data?.data?.appointment;
      expect(appt._financialSource).toBeUndefined();
    });
  });

  // ─── Dual mode ───────────────────────────────────────────────────────────

  describe('Dual mode consistency', () => {
    it('dual: isPaid igual ao V2', async () => {
      if (!sampleAppointmentId) return;
      const [dual, v2] = await Promise.all([
        fetchSingleAppointment(sampleAppointmentId, 'dual'),
        fetchSingleAppointment(sampleAppointmentId, 'v2'),
      ]);
      const dualAppt = dual?.appointment || dual?.data?.appointment;
      const v2Appt = v2?.appointment || v2?.data?.appointment;
      expect(dualAppt.isPaid).toBe(v2Appt.isPaid);
      expect(dualAppt.paymentStatus).toBe(v2Appt.paymentStatus);
    });
  });
});
