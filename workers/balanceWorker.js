// workers/balanceWorker.js
import { Worker } from 'bullmq';
import { redisConnection, moveToDLQ, getQueue } from '../infrastructure/queue/queueConfig.js';
import PatientBalance from '../models/PatientBalance.js';
import Session from '../models/Session.js';


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
            let result;
            
            switch (eventType) {
                case 'BALANCE_DEBIT_REQUESTED':
                    result = await handleDebit(payload, eventId);
                    break;
                case 'BALANCE_CREDIT_REQUESTED':
                    result = await handleCredit(payload, eventId);
                    break;
                default:
                    result = await handleLegacy(payload, eventId);
            }
            
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

async function handleCredit(payload, eventId) {
    const { patientId, amount, description, requestedBy } = payload;

    await PatientBalance.updateOne(
        { patient: patientId },
        {
            $inc: {
                currentBalance: -Math.abs(amount),
                totalCredited: Math.abs(amount)
            },
            $push: {
                transactions: {
                    type: 'credit',
                    amount: Math.abs(amount),
                    description,
                    registeredBy: requestedBy,
                    transactionDate: new Date()
                }
            },
            $set: { lastTransactionAt: new Date() }
        },
        { upsert: true }
    );

    console.log(`[BalanceWorker] Crédito: patient=${patientId}, amount=${amount}`);

    await getQueue('patient-projection').add('rebuild', {
        eventType: 'BALANCE_UPDATED',
        payload: { patientId },
        correlationId: eventId
    });

    return { status: 'success', eventId, patientId, amount };
}

async function handleLegacy(payload, eventId) {
    const { patientId, amount, description, sessionId, appointmentId, registeredBy } = payload;

    await PatientBalance.updateOne(
        { patient: patientId },
        {
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
                    transactionDate: new Date()
                }
            },
            $set: { lastTransactionAt: new Date() }
        },
        { upsert: true }
    );

    await getQueue('patient-projection').add('rebuild', {
        eventType: 'BALANCE_UPDATED',
        payload: { patientId },
        correlationId: eventId
    });

    return { status: 'success', eventId, patientId, amount };
}
