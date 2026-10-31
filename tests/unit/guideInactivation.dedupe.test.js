// Dedupe de inativações concorrentes da mesma guia (2026-10-30, guia 15809471).
import { describe, it, expect, vi } from 'vitest';

let release;
const gate = new Promise(r => { release = r; });
const runTx = vi.fn(async () => {
  await gate;
  return { guideId: 'g1', guideNumber: '1', wasAlreadyCancelled: false, appointmentsCanceled: 20, planCanceled: true, packageCanceled: false };
});

vi.mock('../../utils/transactionRetry.js', () => ({ runTransactionWithRetry: runTx }));
vi.mock('../../models/Appointment.js', () => ({ default: {} }));
vi.mock('../../models/Payment.js', () => ({ default: {} }));
vi.mock('../../models/InsuranceGuide.js', () => ({ default: {} }));
vi.mock('../../models/InsurancePlan.js', () => ({ default: {} }));
vi.mock('../../models/Package.js', () => ({ default: {} }));
vi.mock('../../services/appointment/commands/cancelAppointmentCommand.js', () => ({ executeWithSession: vi.fn() }));
vi.mock('../../domain/payment/isPaymentFinanciallyReversible.js', () => ({ isPaymentFinanciallyReversible: () => true }));

const { cancelInsuranceGuideCascade } = await import('../../domain/guide/cancelInsuranceGuideCascade.js');

describe('cancelInsuranceGuideCascade — pedidos concorrentes', () => {
  it('3 cliques na mesma guia abrem UMA transação e recebem o mesmo resultado', async () => {
    const calls = [1, 2, 3].map(() => cancelInsuranceGuideCascade('g1', {}));
    release();
    const results = await Promise.all(calls);
    expect(runTx).toHaveBeenCalledTimes(1);
    expect(results.every(r => r.appointmentsCanceled === 20)).toBe(true);

    // terminado o primeiro, uma nova chamada roda de novo (idempotente)
    await cancelInsuranceGuideCascade('g1', {});
    expect(runTx).toHaveBeenCalledTimes(2);
  });
});
