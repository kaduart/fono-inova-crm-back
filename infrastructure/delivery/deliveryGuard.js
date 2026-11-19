// infrastructure/delivery/deliveryGuard.js
// Proteção local contra reenvio de mensagens externas (WhatsApp, e-mail).
//
// NÃO é "exatamente uma vez". O provedor externo não participa da transação:
// se o processo cai, ou a chamada estoura o tempo, DEPOIS de o provedor
// aceitar e ANTES de gravarmos o resultado, não há como saber se a mensagem
// saiu. Nesse caso o envio fica `unknown` e NÃO é repetido automaticamente;
// um operador decide (resolveUncertainDelivery).
//
// O que a proteção garante:
//   - Uma chave de entrega tem no máximo UMA tentativa de envio em curso
//     (reserva atômica pelo _id único de outbound_deliveries).
//   - Depois de `sent`, a chave nunca é enviada de novo (reentrega, retry,
//     reinício, dois workers).
//   - Só falhas que provam que nada saiu (`failed`) liberam nova tentativa.
//   - Tentativa abandonada (lease vencido sem resultado) vira `unknown`.
//
// O destino é guardado só como hash; o registro não contém telefone, e-mail
// nem texto da mensagem.

import crypto from 'crypto';
import mongoose from 'mongoose';

export const DELIVERY_COLLECTION = 'outbound_deliveries';
export const DEFAULT_DELIVERY_LEASE_MS = 120_000;

export const DeliveryOutcome = Object.freeze({
    SENT: 'sent',                   // enviado agora
    ALREADY_SENT: 'already_sent',   // já tinha sido enviado; nada feito
    IN_PROGRESS: 'in_progress',     // outra execução está enviando
    UNCERTAIN: 'uncertain'          // resultado externo desconhecido; não reenviar
});

const NOT_SENT_PATTERNS = [
    /ECONNREFUSED/i,
    /ENOTFOUND/i,
    /EAI_AGAIN/i,
    /Número de telefone inválido/i,
    /invalid (phone|recipient|email)/i,
    /não está conectado.*Escaneie o QR code/i,
    // Configuração ausente: o cliente do provedor nem foi criado.
    /(API_KEY|credencial|chave).*não configurad[ao]/i,
    /VPS_WHATSAPP_(URL|TOKEN).*não configurad[ao]s?/i
];

/**
 * true só quando o erro prova que o provedor não aceitou a mensagem.
 * Timeout, reset de conexão, 5xx e erros desconhecidos NÃO provam isso.
 */
export function isDefinitelyNotSent(err) {
    if (!err) return false;
    if (err.deliveryNotSent === true) return true;
    const status = Number(err.status ?? err.statusCode ?? err.response?.status);
    if (status >= 400 && status < 500 && status !== 408) return true;
    const text = `${err.code || ''} ${err.message || ''}`;
    return NOT_SENT_PATTERNS.some((re) => re.test(text));
}

export function destinationHash(channel, destination) {
    const norm = String(destination || '').trim().toLowerCase().replace(/[\s()-]/g, '');
    return crypto.createHash('sha256').update(`${channel}|${norm}`).digest('hex');
}

const coll = () => mongoose.connection.db.collection(DELIVERY_COLLECTION);
const isDup = (err) => err?.code === 11000;
const shortError = (err) => String(err?.message || err || '').slice(0, 300);

/**
 * Executa `send()` no máximo uma vez com sucesso por deliveryKey.
 *
 * @returns {Promise<{ outcome, result?, providerMessageId?, error? }>}
 *   Lança o erro original quando ele prova que nada saiu (o chamador pode
 *   retentar; a chave fica `failed` e aceita nova tentativa).
 */
export async function guardedSend({
    channel,
    deliveryKey,
    destination,
    send,
    providerMessageIdOf = (r) => r?.messages?.[0]?.id || r?.messageId || r?.id || null,
    classifyNotSent = isDefinitelyNotSent,
    leaseMs = DEFAULT_DELIVERY_LEASE_MS,
    now = () => new Date(),
    log
}) {
    if (!deliveryKey) throw new Error('DELIVERY_KEY_MISSING');
    const token = crypto.randomUUID();
    const t0 = now();
    const leaseUntil = new Date(t0.getTime() + leaseMs);
    const destHash = destinationHash(channel, destination);

    // 1. Reserva atômica.
    let reserved = false;
    try {
        await coll().insertOne({
            _id: deliveryKey,
            channel,
            destinationHash: destHash,
            status: 'sending',
            token,
            leaseUntil,
            attempts: 1,
            createdAt: t0,
            startedAt: t0,
            history: [{ at: t0, status: 'sending' }]
        });
        reserved = true;
    } catch (err) {
        if (!isDup(err)) throw err;
    }

    if (!reserved) {
        const existing = await coll().findOne({ _id: deliveryKey });
        if (!existing) throw new Error('DELIVERY_RECORD_VANISHED');

        if (existing.status === 'sent') {
            log?.info?.('delivery_already_sent', 'Envio já realizado; não reenviado', { deliveryKey, channel });
            return { outcome: DeliveryOutcome.ALREADY_SENT, providerMessageId: existing.providerMessageId || null };
        }
        if (existing.status === 'unknown') {
            return { outcome: DeliveryOutcome.UNCERTAIN };
        }
        if (existing.status === 'sending') {
            if (existing.leaseUntil && existing.leaseUntil > t0) {
                return { outcome: DeliveryOutcome.IN_PROGRESS };
            }
            // Tentativa abandonada no meio: a mensagem pode ter saído.
            await coll().updateOne(
                { _id: deliveryKey, status: 'sending', token: existing.token },
                {
                    $set: { status: 'unknown', finishedAt: t0, lastError: 'ATTEMPT_ABANDONED_LEASE_EXPIRED' },
                    $unset: { token: '', leaseUntil: '' },
                    $push: { history: { at: t0, status: 'unknown', reason: 'lease_expired' } }
                }
            );
            log?.warn?.('delivery_uncertain', 'Tentativa anterior abandonada; resultado incerto, sem reenvio automático', { deliveryKey, channel });
            return { outcome: DeliveryOutcome.UNCERTAIN };
        }
        if (existing.status === 'failed') {
            const res = await coll().updateOne(
                { _id: deliveryKey, status: 'failed', attempts: existing.attempts },
                {
                    $set: { status: 'sending', token, leaseUntil, startedAt: t0 },
                    $inc: { attempts: 1 },
                    $push: { history: { at: t0, status: 'sending' } }
                }
            );
            if (res.modifiedCount !== 1) {
                // Outra execução pegou a nova tentativa.
                return { outcome: DeliveryOutcome.IN_PROGRESS };
            }
        } else {
            throw new Error(`DELIVERY_STATUS_INVALID: ${existing.status}`);
        }
    }

    // 2. Envio externo.
    let result;
    try {
        result = await send();
    } catch (err) {
        const t1 = now();
        if (classifyNotSent(err)) {
            await coll().updateOne(
                { _id: deliveryKey, token },
                {
                    $set: { status: 'failed', finishedAt: t1, lastError: shortError(err) },
                    $unset: { token: '', leaseUntil: '' },
                    $push: { history: { at: t1, status: 'failed' } }
                }
            );
            throw err;
        }
        await coll().updateOne(
            { _id: deliveryKey, token },
            {
                $set: { status: 'unknown', finishedAt: t1, lastError: shortError(err) },
                $unset: { token: '', leaseUntil: '' },
                $push: { history: { at: t1, status: 'unknown', reason: 'provider_result_unknown' } }
            }
        );
        log?.warn?.('delivery_uncertain', 'Resultado do provedor desconhecido; sem reenvio automático', { deliveryKey, channel, error: shortError(err) });
        return { outcome: DeliveryOutcome.UNCERTAIN, error: err };
    }

    // 3. Sucesso. Grava mesmo que o lease tenha vencido: sabemos que saiu.
    const t2 = now();
    const providerMessageId = providerMessageIdOf(result) || null;
    await coll().updateOne(
        { _id: deliveryKey, status: { $in: ['sending', 'unknown'] } },
        {
            $set: { status: 'sent', finishedAt: t2, providerMessageId },
            $unset: { token: '', leaseUntil: '' },
            $push: { history: { at: t2, status: 'sent' } }
        }
    );
    return { outcome: DeliveryOutcome.SENT, result, providerMessageId };
}

/**
 * Decisão humana sobre um envio `unknown`: confirmado como enviado (fecha) ou
 * como não enviado (libera nova tentativa). Fica na trilha de auditoria.
 */
export async function resolveUncertainDelivery(deliveryKey, { as, by, note } = {}) {
    if (!['sent', 'failed'].includes(as)) throw new Error('RESOLUTION_INVALID');
    if (!by) throw new Error('RESOLUTION_ACTOR_REQUIRED');
    const at = new Date();
    const res = await coll().updateOne(
        { _id: deliveryKey, status: 'unknown' },
        {
            $set: { status: as, resolvedBy: String(by), resolvedAt: at },
            $push: { history: { at, status: as, reason: 'manual_resolution', by: String(by), note: note ? String(note).slice(0, 200) : undefined } }
        }
    );
    return res.modifiedCount === 1;
}

/**
 * Tentativa abandonada (status `sending` com lease vencido) vira `unknown`, a mesma
 * transição que guardedSend faz quando alguém tenta a chave de novo. Usada pela tela
 * de envios incertos para que o operador possa decidir sem esperar uma nova tentativa.
 * @returns {Promise<boolean>} true se marcou agora.
 */
export async function markAbandonedAsUnknown(deliveryKey, now = new Date()) {
    const res = await coll().updateOne(
        { _id: deliveryKey, status: 'sending', leaseUntil: { $lte: now } },
        {
            $set: { status: 'unknown', finishedAt: now, lastError: 'ATTEMPT_ABANDONED_LEASE_EXPIRED' },
            $unset: { token: '', leaseUntil: '' },
            $push: { history: { at: now, status: 'unknown', reason: 'lease_expired' } }
        }
    );
    return res.modifiedCount === 1;
}

/** Tipo do envio pelo prefixo da chave (sem dados da pessoa). */
export function deliveryKind(deliveryKey) {
    const parts = String(deliveryKey || '').split(':');
    if (parts[1] === 'manual') {
        // wa:manual:<ator>:<tpl|media|...>:... ou wa:manual:<ator>:<chave>:<hash>
        const sub = ['tpl', 'media', 'vps'].includes(parts[3]) ? parts[3] : 'texto';
        return `${parts[0]}:manual:${sub}`;
    }
    return parts.slice(0, 2).join(':') || 'desconhecido';
}

/** Erro do provedor sem números longos (telefone, documento). */
export function redactDeliveryError(text) {
    if (!text) return null;
    return String(text).replace(/\+?\d[\d\s().-]{7,}\d/g, '[número]').slice(0, 200);
}

/**
 * Envios `unknown` e tentativas abandonadas, para decisão humana. Não devolve
 * telefone, texto nem hash do destino.
 */
export async function listUncertainDeliveries({ limit = 100, now = new Date() } = {}) {
    const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const filter = { $or: [{ status: 'unknown' }, { status: 'sending', leaseUntil: { $lte: now } }] };
    const [docs, total] = await Promise.all([
        coll().find(filter, { projection: { destinationHash: 0, token: 0 } }).sort({ createdAt: -1 }).limit(lim).toArray(),
        coll().countDocuments(filter)
    ]);
    return {
        total,
        items: docs.map((d) => ({
            key: d._id,
            kind: deliveryKind(d._id),
            channel: d.channel || null,
            status: d.status === 'sending' ? 'abandoned' : d.status,
            attempts: d.attempts || 1,
            createdAt: d.createdAt || null,
            finishedAt: d.finishedAt || null,
            reason: d.status === 'sending' ? 'lease_expired' : (d.history?.at?.(-1)?.reason || null),
            lastError: redactDeliveryError(d.lastError)
        }))
    };
}

export async function ensureDeliveryIndexes() {
    await coll().createIndex({ status: 1, createdAt: 1 }, { name: 'status_createdAt' });
}
