// models/PaymentOperation.js
// Registro de operação financeira aplicada (idempotência de pagamentos).
//
// Um documento por operação de dinheiro já efetivada. O _id É a chave da
// operação: a unicidade vem do índice obrigatório de _id do MongoDB, que
// existe em qualquer coleção (inclusive em produção) sem migração.
//
// O documento é gravado NA MESMA TRANSAÇÃO que o Payment, o PatientBalance e o
// lançamento do ledger. Então ou tudo foi aplicado e o registro existe, ou
// nada foi aplicado e o registro não existe. Uma reentrega, um reinício do
// worker ou duas execuções concorrentes da mesma operação esbarram no _id
// duplicado e passam a apenas devolver o resultado já gravado.
//
// Ver docs/PAGAMENTOS_IDEMPOTENCIA.md.

import mongoose from 'mongoose';

const paymentOperationSchema = new mongoose.Schema({
    _id: { type: String, required: true },          // operationKey
    kind: {
        type: String,
        // financial_receive: POST /api/v2/financial/receive (síncrono, sem worker).
        // create_sync: POST /api/v2/payments/create-sync (síncrono).
        // balance_credit_direct: POST /api/v2/balance/:id/credit, aplicado no balanceWorker.
        enum: ['multi_payment', 'standalone', 'balance_credit', 'financial_receive', 'create_sync', 'balance_credit_direct'],
        required: true
    },
    // SHA-256 dos campos financeiros da requisição. Mesma chave com outro
    // conteúdo é conflito, nunca reaproveitamento silencioso.
    requestHash: { type: String, required: true },
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', required: true },
    amount: { type: Number, required: true },
    paymentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Payment', default: null },
    eventId: { type: String, default: null },        // evento que aplicou
    result: { type: mongoose.Schema.Types.Mixed, default: null },
    appliedAt: { type: Date, required: true },
    // Efeitos posteriores ao commit (projeções, eventos, notificação).
    // null = ainda não confirmados; a reentrega os executa de novo.
    sideEffectsAt: { type: Date, default: null },
    replays: { type: Number, default: 0 }
}, {
    collection: 'payment_operations',
    versionKey: false
});

paymentOperationSchema.index({ patient: 1, appliedAt: -1 });
paymentOperationSchema.index({ sideEffectsAt: 1, appliedAt: 1 }, { name: 'side_effects_pending' });

const PaymentOperation = mongoose.models.PaymentOperation
    || mongoose.model('PaymentOperation', paymentOperationSchema);

export default PaymentOperation;
