import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../models/Payment.js', () => ({ default: {
    findOne: vi.fn(), findById: vi.fn(), findByIdAndUpdate: vi.fn(), create: vi.fn()
} }));
vi.mock('../../../models/Package.js', () => ({ default: {
    findById: vi.fn(), findByIdAndUpdate: vi.fn()
} }));
vi.mock('../../../models/Session.js', () => ({ default: {} }));
vi.mock('../../../projections/paymentsProjection.js', () => ({ handlePaymentEvent: vi.fn() }));

import Payment from '../../../models/Payment.js';
import Package from '../../../models/Package.js';
import { ParticularHandler } from '../../../services/completeSession/handlers/particularHandler.js';

describe('Conclusão de sessão pré-paga sem novo recebimento', () => {
    beforeEach(() => vi.clearAllMocks());

    it.each([
        ['prepaid', undefined, 200, 'scheduled'],
        [undefined, 'full', 200, 'scheduled'],
        ['prepaid', 'full', 400, 'scheduled'],
        ['prepaid', 'full', 200, 'completed'],
    ])('model=%s paymentType=%s totalPaid=%s status=%s', async (model, paymentType, totalPaid, status) => {
        const pkg = { model, paymentType, totalPaid, sessionsDone: 2, totalValue: 400 };
        Package.findById.mockReturnValue({ session: () => ({ lean: async () => pkg }) });
        const update = { $set: {} };
        const result = ParticularHandler.buildPayment(update, {
            appointment: { patient: { _id: 'patient' }, payment: 'existing-payment', paymentMethod: 'pix' },
            appointmentId: 'appointment', sessionId: 'session', packageId: 'package',
            packageData: pkg, sessionValue: 200, sessionDoc: { status }, mongoSession: {},
            paymentMethod: 'pix', isBalanceOrigin: false
        });

        if (totalPaid < 400) {
            await expect(result).rejects.toMatchObject({
                statusCode: 422,
                code: 'PACKAGE_INSUFFICIENT_COVERAGE',
                message: expect.stringContaining('incluindo esta')
            });
            const error = await result.catch(error => error);
            const message = error.message.replace(/\u00a0/g, ' ');
            expect(message).toContain('Total pago registrado: R$ 200,00');
            expect(message).toContain('2 sessão(ões) × R$ 200,00 = R$ 400,00');
            expect(message).toContain('Diferença sem cobertura registrada: R$ 200,00');
            expect(message).toContain('Confira os pagamentos e as condições do pacote');
            expect(message).toContain('não confirma, por si só, uma dívida');
        } else {
            await expect(result).resolves.toBeNull();
        }
        for (const method of Object.values(Payment)) expect(method).not.toHaveBeenCalled();
        expect(update.$set.payment).toBeUndefined();
        const increments = Package.findByIdAndUpdate.mock.calls.filter(([, change]) => change.$inc);
        expect(increments).toHaveLength(status === 'completed' ? 0 : 1);
    });
});
