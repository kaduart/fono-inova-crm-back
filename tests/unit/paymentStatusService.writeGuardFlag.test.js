/**
 * 🛡️ transitionPaymentStatus() precisa autorizar sua própria escrita perante o
 * AppointmentWriteGuard (2026-08-26)
 *
 * Contexto: validando o recebimento real da NF #124 em produção, todo write
 * de status='paid' feito por receiveInsuranceBatch() (via transitionPaymentStatus)
 * apareceu no log como `[AppointmentWriteGuard] WARN ... hasAuthorizedFlag:false`.
 * `transitionPaymentStatus()` é a ÚNICA via canônica de mudar Payment.status
 * (DOMAIN_INVARIANTS.md #9) — ela mesma nunca carregava nenhuma das flags
 * autorizadas (`_fromCompleteService`/`_fromCancelService`/`_fromWriteGateway`/
 * `_fromInsuranceOrchestrator`), então TODA chamada legítima (13+ call sites
 * em produção: packageController.v2.js, cancelPendingPayments.js, payment.v2.js,
 * InsuranceBatchReceiptService.js, PaymentLifecycleService.js,
 * autoInsuranceSettlementService.js, ConvenioMetricsService.js, paymentWorker.js,
 * paymentService.js, entre outros) gerava esse falso positivo — inofensivo hoje
 * (guard em modo 'warn'), mas quebraria a função mais usada do sistema
 * financeiro no instante em que alguém habilitasse modo 'strict'.
 *
 * Mesma classe de bug documentada em
 * docs/convenio-guide-consumption-audit/2026-07-convenio-guide-consumption-investigation.md
 * (item 6, PR3): sem a flag declarada no schema com `select:false`, o strict
 * mode do Mongoose a descarta silenciosamente em qualquer caminho que não seja
 * `.save()` puro — por isso o teste também confere que a flag sobrevive a uma
 * recarga do documento.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import Payment from '../../models/Payment.js';
import { transitionPaymentStatus } from '../../services/paymentStatusService.js';

let mongod;

beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    await mongoose.connect(mongod.getUri());
}, 30000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

beforeEach(async () => {
    await Payment.deleteMany({});
});

function basePaymentFields(overrides = {}) {
    return {
        patient: new mongoose.Types.ObjectId(),
        amount: 80,
        paymentDate: new Date('2026-08-01T12:00:00Z'),
        paymentMethod: 'convenio',
        billingType: 'convenio',
        status: 'billed',
        insurance: { status: 'billed' },
        ...overrides,
    };
}

describe('transitionPaymentStatus — autorização perante o AppointmentWriteGuard', () => {
    it('NÃO gera WARN do AppointmentWriteGuard ao transicionar billed -> paid (regressão do achado real da NF #124)', async () => {
        const payment = await Payment.create(basePaymentFields());
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await transitionPaymentStatus(payment._id.toString(), 'paid', { silent: true, paidAt: new Date('2026-08-26') });

        const guardWarnCalls = warnSpy.mock.calls.filter(c => String(c[0]).includes('AppointmentWriteGuard'));
        expect(guardWarnCalls).toHaveLength(0);
        warnSpy.mockRestore();
    });

    it('a flag _fromPaymentStatusService é persistida e sobrevive a uma recarga (mesma regressão do PR3 de convênio)', async () => {
        const payment = await Payment.create(basePaymentFields());

        await transitionPaymentStatus(payment._id.toString(), 'paid', { silent: true, paidAt: new Date('2026-08-26') });

        const reloaded = await Payment.findById(payment._id).select('+_fromPaymentStatusService').lean();
        expect(reloaded._fromPaymentStatusService).toBe(true);
        expect(reloaded.status).toBe('paid');
    });

    it('continua gerando WARN se algum OUTRO caminho mudar status sem passar por transitionPaymentStatus (o guard continua vivo)', async () => {
        const payment = await Payment.create(basePaymentFields());
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await Payment.collection.updateOne({ _id: payment._id }, { $set: { status: 'paid' } });

        const guardWarnCalls = warnSpy.mock.calls.filter(c => String(c[0]).includes('AppointmentWriteGuard'));
        expect(guardWarnCalls.length).toBeGreaterThan(0);
        warnSpy.mockRestore();
    });
});
