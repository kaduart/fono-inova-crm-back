// workers/balanceWorker.js
import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ, getQueue } from '../infrastructure/queue/queueConfig.js';
import PatientBalance from '../models/PatientBalance.js';
import Session from '../models/Session.js';
import { runPaymentOperation, operationKeyFor, markSideEffectsDone } from '../services/paymentOperations.js';


const processedEvents = new Map();
const EVENT_CACHE_TTL = 24 * 60 * 60 * 1000;

setInterval(() => {
    const now = Date.now();
    for (const [eventId, timestamp] of processedEvents) {
        if (now - timestamp > EVENT_CACHE_TTL) {
            processedEvents.delete(eventId);
        }
    }
}, 60 * 60 * 1000);

export function startBalanceWorker() {
    const worker = new Worker('balance-update', async (job) => {
        const { eventId, eventType, correlationId, payload } = job.data;
        
        console.log(`[BalanceWorker] Processando ${eventType}: ${eventId}`, {
            attempt: job.attemptsMade + 1
        });
        
        // IDEMPOTÊNCIA
        if (processedEvents.has(eventId)) {
            console.log(`[BalanceWorker] Evento já processado: ${eventId}`);
            return { status: 'already_processed' };
        }
        
        try {
            const result = await handleBalanceEvent(eventType, payload, eventId);
            
            processedEvents.set(eventId, Date.now());
            return result;
            
        } catch (error) {
            console.error(`[BalanceWorker] Erro:`, error.message);
            
            if (job.attemptsMade >= 4) {
                await moveToDLQ(job, error);
            }
            
            throw error;
        }
        
    }, {
        connection: redisConnection,
        concurrency: 5,
        limiter: { max: 10, duration: 1000 }
    });
    
    worker.on('completed', (job, result) => {
        console.log(`[BalanceWorker] Job ${job.id} completado:`, result.status);
    });
    
    worker.on('failed', (job, error) => {
        console.error(`[BalanceWorker] Job ${job?.id} falhou:`, error.message);
    });
    
    console.log('[BalanceWorker] Worker iniciado');
    return worker;
}

// Eventos que chegam à fila balance-update mas NÃO são lançamento no saldo do
// paciente. Antes caíam em handleLegacy e viravam $inc no PatientBalance:
//   - INSURANCE_PAYMENT_AUTO_SETTLED: baixa de convênio (dinheiro da operadora).
//     Payload sem patientId; o upsert criava/somava um PatientBalance com
//     patient:null (provado em banco descartável: 2 entregas de 180 = 360 no
//     documento sem paciente), que entra nos totais de dívida.
// Só registra e sai; patient-projection continua recebendo o evento.
const NOT_A_BALANCE_ENTRY = new Set(['INSURANCE_PAYMENT_AUTO_SETTLED']);

// Despacho único (o worker e os testes usam o mesmo caminho).
export async function handleBalanceEvent(eventType, payload, eventId) {
    switch (eventType) {
        case 'BALANCE_DEBIT_REQUESTED':
            return handleDebit(payload, eventId);
        case 'BALANCE_CREDIT_REQUESTED':
            return handleCredit(payload, eventId);
        default:
            if (NOT_A_BALANCE_ENTRY.has(eventType)) {
                console.log(`[BalanceWorker] ${eventType} não é lançamento no saldo do paciente — ignorado (${eventId})`);
                return { status: 'skipped', reason: 'not_a_patient_balance_entry', eventId, eventType };
            }
            return handleLegacy(payload, eventId, eventType);
    }
}

// exportado só pra teste unitário direto do handler (sem subir BullMQ/Redis)
export async function handleDebit(payload, eventId) {
    const { patientId, amount, description, sessionId, appointmentId, requestedBy } = payload;

    // 🛡️ VALIDAÇÃO NO CONSUMIDOR: mesmo a rota validando antes de publicar
    // (routes/balance.v2.js), o worker não pode confiar cegamente no payload
    // — evento antigo já enfileirado antes da validação existir, reentrega
    // manual, ou publisher futuro que pule a checagem. description é required
    // no schema (PatientBalance.js); gravar sem ela some sem erro num
    // updateOne sem runValidators e só quebra dias depois, quando outro
    // fluxo der .save() no documento inteiro (achado 2026-09-15, Julia
    // Boarati — 5 lançamentos assim, todos com correlationId ausente,
    // assinatura compatível com este caminho). Rejeita e deixa o BullMQ
    // reter/mover pra DLQ — nunca grava dado quebrado.
    if (typeof description !== 'string' || description.trim().length === 0) {
        throw new Error(`INVALID_PAYLOAD: description ausente/vazia para débito de ${patientId} (appointment=${appointmentId})`);
    }
    if (!amount || Number(amount) <= 0) {
        throw new Error(`INVALID_PAYLOAD: amount inválido (${amount}) para débito de ${patientId}`);
    }
    if (!patientId) {
        throw new Error('INVALID_PAYLOAD: patientId ausente');
    }

    if (sessionId) {
        const session = await Session.findById(sessionId).select('status').lean();
        if (session && session.status !== 'completed') {
            throw new Error(`STATE_GUARD: Session ${sessionId} status=${session.status}`);
        }
    }

    const debitEntry = {
        type: 'debit',
        amount: Math.abs(amount),
        description,
        sessionId,
        appointmentId,
        registeredBy: requestedBy,
        transactionDate: new Date()
    };

    // 🛡️ IDEMPOTÊNCIA NO CONSUMIDOR: "1 appointment = 1 débito ATIVO" — mais
    // restrito que PatientBalance.addDebit() de propósito: addDebit() ignora
    // isDeleted, o que bloquearia pra sempre um novo débito legítimo depois
    // de um estorno/reversão (isDeleted:true) do débito anterior pro mesmo
    // appointment. `isDeleted: {$ne:true}` dentro do próprio $elemMatch
    // exclui débitos revertidos da checagem de duplicidade — só bloqueia
    // reentrega do MESMO evento (débito ainda ativo, isDeleted:false).
    // O filtro exige que NENHUM débito ATIVO exista ainda pra esse
    // appointment — reentrega do mesmo evento (retry do BullMQ, replay
    // manual) encontra matchedCount 0 e não duplica. runValidators garante
    // que a movimentação nova siga o schema mesmo escrevendo via updateOne
    // (sem isso é exatamente como os 5 lançamentos quebrados entraram: $push
    // cru sem validação).
    if (appointmentId) {
        const guardedUpdate = await PatientBalance.updateOne(
            {
                patient: patientId,
                transactions: { $not: { $elemMatch: { type: 'debit', appointmentId, isDeleted: { $ne: true } } } }
            },
            {
                $inc: { currentBalance: amount, totalDebited: amount },
                $push: { transactions: debitEntry },
                $set: { lastTransactionAt: new Date() }
            },
            { runValidators: true, context: 'query' }
        );

        if (guardedUpdate.matchedCount === 0) {
            const alreadyExists = await PatientBalance.exists({
                patient: patientId,
                transactions: { $elemMatch: { type: 'debit', appointmentId, isDeleted: { $ne: true } } }
            });
            if (alreadyExists) {
                console.log(`[BalanceWorker] ⚠️ Débito já existe pra appointment ${appointmentId} — evento duplicado ignorado (idempotente)`);
                return { status: 'skipped', reason: 'duplicate_appointment_debit', eventId, patientId, appointmentId };
            }
            // Documento do paciente ainda não existe — cria (sem risco de
            // duplicar, já que não havia PatientBalance nenhum pra conferir).
            try {
                await PatientBalance.create({
                    patient: patientId,
                    currentBalance: amount,
                    totalDebited: amount,
                    transactions: [debitEntry],
                    lastTransactionAt: new Date()
                });
            } catch (createErr) {
                if (createErr?.code === 11000) {
                    // Corrida: outro worker criou o documento entre o updateOne e este create.
                    // Reaplica o updateOne guardado — se já tiver o débito, vira idempotente.
                    const retryUpdate = await PatientBalance.updateOne(
                        {
                            patient: patientId,
                            transactions: { $not: { $elemMatch: { type: 'debit', appointmentId, isDeleted: { $ne: true } } } }
                        },
                        {
                            $inc: { currentBalance: amount, totalDebited: amount },
                            $push: { transactions: debitEntry },
                            $set: { lastTransactionAt: new Date() }
                        },
                        { runValidators: true, context: 'query' }
                    );
                    if (retryUpdate.matchedCount === 0) {
                        console.log(`[BalanceWorker] ⚠️ Débito já existe pra appointment ${appointmentId} (corrida resolvida) — ignorado`);
                        return { status: 'skipped', reason: 'duplicate_appointment_debit_race', eventId, patientId, appointmentId };
                    }
                } else {
                    throw createErr;
                }
            }
        }
    } else {
        // Sem appointmentId não há chave natural de idempotência — só valida
        // schema na escrita, sem tentar deduplicar (mesma limitação que já
        // existia; rota v2 hoje exige appointmentId, então este ramo só serve
        // eventos legados/outros publishers).
        await PatientBalance.updateOne(
            { patient: patientId },
            {
                $inc: { currentBalance: amount, totalDebited: amount },
                $push: { transactions: debitEntry },
                $set: { lastTransactionAt: new Date() }
            },
            { upsert: true, runValidators: true, context: 'query' }
        );
    }

    console.log(`[BalanceWorker] Débito: patient=${patientId}, amount=${amount}`);

    await getQueue('patient-projection').add('rebuild', {
        eventType: 'BALANCE_UPDATED',
        payload: { patientId },
        correlationId: eventId
    });

    return { status: 'success', eventId, patientId, amount };
}

// Crédito direto no saldo (POST /v2/balance/:patientId/credit).
// Convenção (B-1): currentBalance > 0 = paciente deve; crédito REDUZ currentBalance
// e soma em totalCredited, igual a PatientBalance.addCredit e às quitações.
//
// Idempotência: o crédito e o recibo em payment_operations são gravados na MESMA
// transação; a chave é a idempotencyKey do evento (estável entre reenvios HTTP
// quando o cliente manda Idempotency-Key) ou, em evento antigo sem ela, o eventId.
// Reentrega do BullMQ, reinício do worker e dois workers com o mesmo evento
// aplicam uma vez. O Map em memória acima é só atalho.
export async function handleCredit(payload, eventId) {
    const { patientId, amount, description, requestedBy } = payload;
    if (!patientId) throw new Error('INVALID_PAYLOAD: patientId ausente');
    if (!amount || Number(amount) <= 0) throw new Error(`INVALID_PAYLOAD: amount inválido (${amount}) para crédito de ${patientId}`);
    const value = Math.abs(Number(amount));

    const operationKey = operationKeyFor('balance_credit_direct', { idempotencyKey: payload.idempotencyKey, eventId });
    const op = await runPaymentOperation({
        operationKey,
        kind: 'balance_credit_direct',
        request: { patientId: String(patientId), amount: value, paymentMethod: null },
        eventId,
        apply: async ({ session, appliedAt }) => {
            await PatientBalance.updateOne(
                { patient: patientId },
                {
                    $inc: { currentBalance: -value, totalCredited: value },
                    $push: {
                        transactions: {
                            type: 'credit',
                            amount: value,
                            description,
                            registeredBy: requestedBy,
                            operationKey,
                            transactionDate: appliedAt
                        }
                    },
                    $set: { lastTransactionAt: appliedAt }
                },
                { upsert: true, session }
            );
            return { result: { patientId: String(patientId), amount: value } };
        }
    });

    if (op.applied) {
        console.log(`[BalanceWorker] Crédito: patient=${patientId}, amount=${value}, op=${operationKey}`);
    } else {
        console.log(`[BalanceWorker] Crédito já aplicado antes (reentrega): ${operationKey}`);
    }

    if (op.applied || op.sideEffectsPending) {
        await getQueue('patient-projection').add('rebuild', {
            eventType: 'BALANCE_UPDATED',
            payload: { patientId },
            correlationId: eventId
        }, { jobId: `balance_projection_${operationKey}`.replace(/:/g, '_') });
        await markSideEffectsDone(operationKey);
    }

    return { status: op.applied ? 'success' : 'already_processed', eventId, patientId, amount: value, operationKey };
}

// Caminho legado (BALANCE_UPDATE_REQUESTED e os PAYMENT_* roteados para esta
// fila). Regras novas, todas sem escrita quando falham:
//   1. Só lança com patientId, amount numérico diferente de zero e description
//      (description é obrigatória no schema; updateOne sem validação gravava
//      lançamento quebrado). Payload que não é lançamento vira "skipped", sem
//      retentar: retentar não conserta payload.
//   2. Idempotência persistente: o eventId fica no próprio lançamento
//      (transactions.sourceEventId) e o filtro recusa aplicar de novo. Vale
//      para reentrega do BullMQ, reinício do worker, dois workers ao mesmo
//      tempo e retry depois de o $inc já ter sido aplicado. O Map em memória
//      do worker é só atalho.
export async function handleLegacy(payload, eventId, eventType = 'legacy') {
    const { patientId, description, sessionId, appointmentId, registeredBy } = payload || {};
    const amount = Number(payload?.amount);

    if (!patientId) {
        console.warn(`[BalanceWorker] ${eventType} sem patientId — não lança no saldo (${eventId})`);
        return { status: 'skipped', reason: 'missing_patient_id', eventId, eventType };
    }
    if (!Number.isFinite(amount) || amount === 0) {
        console.warn(`[BalanceWorker] ${eventType} sem amount válido — não lança no saldo (${eventId})`);
        return { status: 'skipped', reason: 'invalid_amount', eventId, eventType, patientId };
    }
    if (typeof description !== 'string' || description.trim().length === 0) {
        console.warn(`[BalanceWorker] ${eventType} sem description — não lança no saldo (${eventId})`);
        return { status: 'skipped', reason: 'missing_description', eventId, eventType, patientId };
    }
    if (!eventId) {
        throw new Error(`INVALID_EVENT: ${eventType} sem eventId — sem chave de idempotência`);
    }

    const filter = { patient: patientId, 'transactions.sourceEventId': { $ne: eventId } };
    const update = {
        $inc: {
            currentBalance: amount,
            totalDebited: amount > 0 ? amount : 0,
            totalCredited: amount < 0 ? Math.abs(amount) : 0
        },
        $push: {
            transactions: {
                type: amount > 0 ? 'debit' : 'credit',
                amount: Math.abs(amount),
                description,
                sessionId,
                appointmentId,
                registeredBy,
                sourceEventId: eventId,
                transactionDate: new Date()
            }
        },
        $set: { lastTransactionAt: new Date() }
    };

    let res;
    try {
        res = await PatientBalance.updateOne(filter, update, { upsert: true, runValidators: true, context: 'query' });
    } catch (err) {
        // E11000 no índice único de patient: o documento já existe e já tem
        // este evento (o upsert tentou criar outro), ou foi criado agora por
        // outra entrega. Sem upsert: 0 casados = já aplicado.
        if (err?.code !== 11000) throw err;
        res = await PatientBalance.updateOne(filter, update, { runValidators: true, context: 'query' });
    }
    if (!res.upsertedCount && !res.modifiedCount) {
        console.log(`[BalanceWorker] ${eventType} ${eventId} já lançado — reentrega ignorada`);
        return { status: 'already_processed', eventId, eventType, patientId };
    }

    await getQueue('patient-projection').add('rebuild', {
        eventType: 'BALANCE_UPDATED',
        payload: { patientId },
        correlationId: eventId
    });

    return { status: 'success', eventId, patientId, amount };
}
