/**
 * 🔴 REPRODUÇÃO: race condition no fix atual de recordPaymentReceived()
 *
 * O fix de hoje (`FinancialLedger.exists({payment, type:'payment_received'})`
 * antes de creditar) é check-then-act, não atômico. Este teste prova que duas
 * chamadas concorrentes ainda produzem dois créditos, porque ambas podem
 * passar pelo `exists()` (que retorna false pras duas) ANTES de qualquer uma
 * commitar o `.save()`.
 *
 * Este arquivo deve ficar VERMELHO contra o código de
 * services/financialLedgerService.js como está agora (idempotência via
 * exists()) e VERDE depois do redesenho (chave de ciclo determinística +
 * índice único, sem check-then-act).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import Payment from '../../models/Payment.js';
import FinancialLedger from '../../models/FinancialLedger.js';
import { recordPaymentReceived } from '../../services/financialLedgerService.js';

let mongod;

beforeAll(async () => {
    // Precisa de replica set: queremos duas operações de escrita concorrentes
    // reais no servidor, não só duas Promises no processo do teste.
    mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await mongoose.connect(mongod.getUri());
    // Mongoose cria índices em background (autoIndex) — sem esperar
    // .init(), o índice único (correlationId, type) pode não existir ainda
    // quando o teste dispara as duas escritas concorrentes, mascarando a
    // proteção que estamos testando.
    await FinancialLedger.init();
}, 60000);

afterAll(async () => {
    await mongoose.disconnect();
    await mongod.stop();
});

beforeEach(async () => {
    await Payment.deleteMany({});
    await FinancialLedger.collection.deleteMany({});
});

function fakePayment(overrides = {}) {
    return {
        _id: new mongoose.Types.ObjectId(),
        patient: new mongoose.Types.ObjectId(),
        appointment: new mongoose.Types.ObjectId(),
        session: new mongoose.Types.ObjectId(),
        amount: 160,
        paymentMethod: 'pix',
        paidAt: new Date('2026-08-21T18:00:00Z'),
        paymentDate: new Date('2026-08-21T18:00:00Z'),
        ...overrides,
    };
}

describe('[REPRO] recordPaymentReceived — race condition real (duas chamadas concorrentes)', () => {
    it('exatamente UM crédito deve sobreviver a duas chamadas concorrentes pro MESMO ciclo de pagamento', async () => {
        const payment = fakePayment();

        // Concorrência real: as duas chamadas iniciam antes de qualquer uma
        // terminar — simula create-sync e completeSessionService.v2.js
        // processando o "primeiro recebimento" quase ao mesmo tempo.
        const results = await Promise.allSettled([
            recordPaymentReceived(payment, { correlationId: `create_sync_${payment._id}_1` }),
            recordPaymentReceived(payment, { correlationId: `front_${payment._id}_2` }),
        ]);
        console.log('[repro] resultados:', results.map(r => r.status === 'fulfilled' ? 'ok' : r.reason?.message));

        const entries = await FinancialLedger.find({ payment: payment._id, type: 'payment_received' }).lean();
        console.log('[repro] entradas encontradas:', entries.length);
        expect(entries).toHaveLength(1);

        // Nenhuma das duas chamadas deveria ter propagado um erro pro chamador
        // (o segundo caminho precisa resolver pra "já creditado", não explodir
        // a transação de quem chamou — ex: completeSessionService.v2.js).
        expect(results.every(r => r.status === 'fulfilled')).toBe(true);
    }, 20000);
});
