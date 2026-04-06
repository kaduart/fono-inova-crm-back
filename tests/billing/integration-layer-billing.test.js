/**
 * ============================================================================
 * INTEGRATION LAYER + BILLING — Testes dos 3 cenários obrigatórios
 * ============================================================================
 *
 * O que testa:
 *   1. Fluxo feliz     → APPOINTMENT_BILLING_REQUESTED cria Payment
 *   2. Idempotência    → segundo evento retorna { duplicate: true }
 *   3. Skips corretos  → convenio / package_prepaid / manual_balance ignorados
 *
 * Run: npm run test:billing:integration
 *       ou: npx vitest run tests/billing/integration-layer-billing.test.js
 *
 * Banco usado: crm_test_e2e  ← NUNCA produção
 * ============================================================================
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';

import Appointment from '../../models/Appointment.js';
import Payment     from '../../models/Payment.js';
import Patient     from '../../models/Patient.js';
import Doctor      from '../../models/Doctor.js';
import { processJob } from '../../domains/billing/workers/billingConsumerWorker.js';

// ─── Banco de teste — local por padrão, nunca produção ──────────────────────
const TEST_DB = process.env.TEST_MONGO_URI || 'mongodb://localhost:27017/crm_test_billing';

// ─── IDs de referência (criados no beforeAll) ────────────────────────────────
let patient;
let doctor;

// ─── Helper: cria appointment com paymentOrigin configurável ─────────────────
async function createAppointment(paymentOrigin, overrides = {}) {
    return Appointment.create({
        patient:          patient._id,
        doctor:           doctor._id,
        specialty:        'fonoaudiologia',
        date:             new Date(),
        time:             '10:00',
        serviceType:      'session',
        sessionValue:     150,
        paymentMethod:    'pix',
        billingType:      'particular',
        paymentOrigin,
        operationalStatus: 'completed',
        clinicalStatus:    'completed',
        paymentStatus:    'pending',
        ...overrides,
    });
}

// ─── Helper: cria job fake no formato que o worker espera ────────────────────
function makeJob(appointmentId, paymentOrigin, overrides = {}) {
    const correlationId = `test-${uuidv4()}`;
    return {
        id:   `job-${uuidv4()}`,
        data: {
            eventType:     'APPOINTMENT_BILLING_REQUESTED',
            correlationId,
            payload: {
                appointmentId: appointmentId.toString(),
                patientId:     patient._id.toString(),
                paymentType:   paymentOrigin,
                amount:        150,
                ...overrides,
            },
        },
        attemptsMade: 0,
    };
}

// =============================================================================
// SETUP / TEARDOWN
// =============================================================================

beforeAll(async () => {
    await mongoose.connect(TEST_DB);

    const suffix = uuidv4().slice(0, 8);

    patient = await Patient.create({
        fullName:    `Paciente Teste ${suffix}`,
        dateOfBirth: new Date('1990-01-01'),
        phone:       '11999999999',
    });

    doctor = await Doctor.create({
        fullName:      `Doutor Teste ${suffix}`,
        email:         `dr.${suffix}@teste.com`,
        specialty:     'fonoaudiologia',
        licenseNumber: `CRF-${suffix}`,
        phoneNumber:   '11988888888',
    });
});

afterAll(async () => {
    // Limpa apenas dados criados por estes testes
    await Payment.deleteMany({ patientId: patient._id });
    await Appointment.deleteMany({ patient: patient._id });
    await Patient.findByIdAndDelete(patient._id);
    await Doctor.findByIdAndDelete(doctor._id);

    await mongoose.disconnect();
});

// =============================================================================
// CENÁRIO 1 — FLUXO FELIZ
// =============================================================================

describe('Cenário 1 — Fluxo feliz (auto_per_session)', () => {
    it('cria Payment ao processar APPOINTMENT_BILLING_REQUESTED', async () => {
        const appointment = await createAppointment('auto_per_session');
        const job         = makeJob(appointment._id, 'auto_per_session');

        const result = await processJob(job);

        // Worker deve retornar success
        expect(result.status).toBe('success');
        expect(result.duplicate).toBeFalsy();
        expect(result.appointmentId).toBe(appointment._id.toString());

        // Payment deve ter sido criado no banco
        const payment = await Payment.findById(result.paymentId);
        expect(payment).toBeTruthy();
        expect(payment.patientId.toString()).toBe(patient._id.toString());
        expect(payment.appointmentId.toString()).toBe(appointment._id.toString());
        expect(payment.amount).toBe(150);
        expect(payment.status).toBe('pending');
        expect(payment.source).toBe('appointment');
        expect(payment.paymentMethod).toBe('pix');
    });
});

// =============================================================================
// CENÁRIO 2 — IDEMPOTÊNCIA
// =============================================================================

describe('Cenário 2 — Idempotência (mesmo appointmentId 2x)', () => {
    it('retorna duplicate:true sem criar segundo Payment', async () => {
        const appointment = await createAppointment('auto_per_session');
        const job1        = makeJob(appointment._id, 'auto_per_session');
        const job2        = makeJob(appointment._id, 'auto_per_session');

        // Primeira chamada → cria payment
        const result1 = await processJob(job1);
        expect(result1.status).toBe('success');
        expect(result1.duplicate).toBeFalsy();

        // Segunda chamada → idempotência
        const result2 = await processJob(job2);
        expect(result2.status).toBe('success');
        expect(result2.duplicate).toBe(true);

        // Apenas 1 payment no banco
        const payments = await Payment.find({ appointmentId: appointment._id });
        expect(payments).toHaveLength(1);
    });
});

// =============================================================================
// CENÁRIO 3 — SKIPS (não interferir em outros fluxos)
// =============================================================================

describe('Cenário 3 — Skips corretos', () => {
    it('convenio → retorna HANDLED_ELSEWHERE sem criar Payment', async () => {
        const appointment = await createAppointment('convenio', { billingType: 'convenio' });
        const job         = makeJob(appointment._id, 'convenio');

        const result = await processJob(job);

        expect(result.status).toBe('skipped');
        expect(result.reason).toBe('HANDLED_ELSEWHERE');

        const payment = await Payment.findOne({ appointmentId: appointment._id });
        expect(payment).toBeNull();
    });

    it('package_prepaid → retorna PACKAGE_HANDLES_CREDIT sem criar Payment', async () => {
        const appointment = await createAppointment('package_prepaid');
        const job         = makeJob(appointment._id, 'package_prepaid');

        const result = await processJob(job);

        expect(result.status).toBe('skipped');
        expect(result.reason).toBe('PACKAGE_HANDLES_CREDIT');

        const payment = await Payment.findOne({ appointmentId: appointment._id });
        expect(payment).toBeNull();
    });

    it('manual_balance → retorna BALANCE_ALREADY_ADDED sem criar Payment', async () => {
        const appointment = await createAppointment('manual_balance');
        const job         = makeJob(appointment._id, 'manual_balance');

        const result = await processJob(job);

        expect(result.status).toBe('skipped');
        expect(result.reason).toBe('BALANCE_ALREADY_ADDED');

        const payment = await Payment.findOne({ appointmentId: appointment._id });
        expect(payment).toBeNull();
    });

    it('appointmentId inexistente → lança NOT_FOUND', async () => {
        const fakeId = new mongoose.Types.ObjectId();
        const job    = makeJob(fakeId, 'auto_per_session');

        await expect(processJob(job)).rejects.toThrow('Appointment not found');
    });
});
