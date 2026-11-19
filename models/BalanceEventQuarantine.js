// models/BalanceEventQuarantine.js
// Eventos que chegaram ao consumidor do saldo (balance-update) ou a um ajuste de saldo e
// NÃO foram aplicados por não caberem no contrato: tipo desconhecido, payload sem os campos
// exigidos ou correspondência ambígua. Ficam aqui para análise; nada é descartado em silêncio
// e nenhum saldo é alterado.
//
// Diagnóstico seguro: só tipo, ids internos, motivo e quais campos vieram (nomes, não valores).
// Nada de nome, telefone, descrição ou valor livre do payload.
//
// Idempotente: uma linha por (source, eventId); reentregas só somam `deliveries`.
import mongoose from 'mongoose';

const balanceEventQuarantineSchema = new mongoose.Schema({
    source: { type: String, required: true },          // 'balance-update' | 'payment-patch'
    eventId: { type: String, required: true },
    eventType: { type: String, required: true },
    reason: { type: String, required: true },          // código estável, ex.: 'tipo_fora_do_contrato'
    paymentId: { type: String, default: null },
    patientId: { type: String, default: null },
    appointmentId: { type: String, default: null },
    payloadFields: { type: [String], default: [] },    // só os nomes das chaves
    detail: { type: mongoose.Schema.Types.Mixed, default: null }, // números e códigos, nunca texto livre
    deliveries: { type: Number, default: 1 },
    firstSeenAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    status: { type: String, enum: ['open', 'reviewed'], default: 'open' }
}, { collection: 'balance_event_quarantine', versionKey: false });

balanceEventQuarantineSchema.index({ source: 1, eventId: 1 }, { unique: true });
balanceEventQuarantineSchema.index({ status: 1, eventType: 1, firstSeenAt: -1 });

const BalanceEventQuarantine = mongoose.models.BalanceEventQuarantine
    || mongoose.model('BalanceEventQuarantine', balanceEventQuarantineSchema);

const idOf = (v) => (v == null ? null : String(v));

/**
 * Registra (ou soma uma entrega a) um evento em quarentena. Nunca lança por duplicidade.
 */
export async function quarantineBalanceEvent({ source, eventId, eventType, reason, payload, detail }) {
    const key = { source, eventId: String(eventId || `sem_eventId:${eventType}:${idOf(payload?.paymentId) || 'x'}`) };
    const now = new Date();
    const update = {
        $setOnInsert: {
            ...key,
            eventType: eventType || 'desconhecido',
            reason,
            paymentId: idOf(payload?.paymentId),
            patientId: idOf(payload?.patientId),
            appointmentId: idOf(payload?.appointmentId),
            payloadFields: payload && typeof payload === 'object' ? Object.keys(payload).sort() : [],
            detail: detail ?? null,
            firstSeenAt: now,
            status: 'open'
        },
        $inc: { deliveries: 1 },
        $set: { lastSeenAt: now }
    };
    // $setOnInsert e $inc no mesmo campo conflitam: deliveries começa em 1 pelo $inc.
    delete update.$setOnInsert.deliveries;
    try {
        await BalanceEventQuarantine.updateOne(key, update, { upsert: true });
    } catch (err) {
        if (err?.code !== 11000) throw err;
        // Corrida de dois upserts: o segundo vira atualização.
        await BalanceEventQuarantine.updateOne(key, { $inc: { deliveries: 1 }, $set: { lastSeenAt: now } });
    }
}

export default BalanceEventQuarantine;
