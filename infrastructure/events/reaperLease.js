// infrastructure/events/reaperLease.js
/**
 * Posse do REAPER do Event Store, compartilhada entre o Node (crons/eventReaper.cron.js)
 * e o executor da KAS (kas-core: cmd/kas-event-reaper, internal/legacy/crmeventstore/lease.go).
 *
 * É o MESMO documento que a KAS usa: coleção `kas_event_reaper_lease`,
 * `_id: 'crm-eventstore-reaper'`, campos holder/token/expiresAt/renewedAt.
 * Todos os horários vêm do servidor ($$NOW), então máquinas com relógios
 * diferentes concordam sobre quem está com a posse.
 *
 * - Só um dono vivo por vez: tomar a posse só funciona com o prazo vencido,
 *   e cada tomada gera um token novo.
 * - Escrita cercada (fence): cada recuperação de evento roda numa transação
 *   que também grava no documento da posse, condicionada ao MESMO token e ao
 *   prazo vivo. Se outro dono tomou a posse, a transação não confirma e nada
 *   é gravado (ReaperLeaseLostError).
 * - release(): devolve a posse na parada limpa (SIGTERM), para o próximo dono
 *   assumir na hora. Numa queda sem release, o próximo espera o prazo vencer.
 *
 * Ver docs/EVENTSTORE_OWNERSHIP.md, seção "Dono do reaper: Node e KAS".
 */

import os from 'node:os';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

export const REAPER_LEASE_COLLECTION = 'kas_event_reaper_lease';
export const REAPER_LEASE_ID = 'crm-eventstore-reaper';
/** Padrão igual ao da KAS (-lease-ttl 12m): maior que o intervalo de 5 min. */
export const DEFAULT_REAPER_LEASE_TTL_MS = 12 * 60_000;

export class ReaperLeaseLostError extends Error {
    constructor(stage = 'fence') {
        super(`Posse do reaper perdida (${stage}); nada gravado`);
        this.name = 'ReaperLeaseLostError';
        this.code = 'REAPER_LEASE_LOST';
    }
}

/** EVENT_REAPER_SHARED_LEASE: 'on' (Node disputa e cerca a posse) ou 'off' (padrão: só consulta). */
export function sharedLeaseModeFromEnv(env = process.env) {
    const raw = (env.EVENT_REAPER_SHARED_LEASE ?? '').trim().toLowerCase();
    if (raw === '' || raw === 'off') return 'off';
    if (raw === 'on') return 'on';
    throw new Error(`EVENT_REAPER_SHARED_LEASE inválido: "${env.EVENT_REAPER_SHARED_LEASE}". Use "on" ou "off".`);
}

export function reaperLeaseTtlFromEnv(env = process.env) {
    const raw = env.EVENT_REAPER_LEASE_TTL_MS;
    if (raw === undefined || raw === '') return DEFAULT_REAPER_LEASE_TTL_MS;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 2000 || n > 60 * 60_000) {
        throw new Error(`EVENT_REAPER_LEASE_TTL_MS inválido: "${raw}" (inteiro entre 2000 e 3600000 ms)`);
    }
    return n;
}

export function defaultReaperHolder() {
    return `crm-node:${os.hostname()}:${process.pid}`;
}

const LIVE = { $expr: { $gt: ['$expiresAt', '$$NOW'] } };
const EXPIRED = { $expr: { $lte: ['$expiresAt', '$$NOW'] } };

function collectionOf(db) {
    return (db || mongoose.connection.db).collection(REAPER_LEASE_COLLECTION);
}

/**
 * Dono vivo da posse, lido só com leitura (não cria a coleção).
 * @returns {Promise<{holder:string, msLeft:number}|null>}
 */
export async function liveReaperLeaseHolder(db) {
    const [doc] = await collectionOf(db).aggregate([
        { $match: { _id: REAPER_LEASE_ID } },
        { $project: { holder: 1, live: { $gt: ['$expiresAt', '$$NOW'] }, msLeft: { $subtract: ['$expiresAt', '$$NOW'] } } }
    ]).toArray();
    if (!doc || !doc.live) return null;
    return { holder: doc.holder || 'desconhecido', msLeft: Number(doc.msLeft) };
}

/**
 * Marca que o reaper do Node participa da posse compartilhada (modo on).
 * Grava `participants.crmNode = { at: $$NOW, holder, mode: 'on' }` no MESMO
 * documento da posse, a cada ciclo, tenha ou não ficado com a posse.
 * O executor da KAS com `-require-crm-node-lease` só age enquanto essa marca
 * estiver fresca. Um Node com a variável ausente/off, ou apontando para outro
 * banco/coleção, nunca grava a marca ali, então a KAS fica parada em vez de
 * virar um segundo dono. O documento já existe porque acquire() roda antes.
 */
export async function markCrmNodeParticipant(db, holder = defaultReaperHolder()) {
    await collectionOf(db).updateOne(
        { _id: REAPER_LEASE_ID },
        [{ $set: { 'participants.crmNode': { at: '$$NOW', holder, mode: 'on' } } }]
    );
}

/**
 * Leitura (sem escrita) para conferir a configuração antes da troca.
 * @returns {Promise<{exists:boolean, holder?:string, live?:boolean, msLeft?:number, nodeMarkerAgeMs?:number|null, nodeMarkerHolder?:string|null}>}
 */
export async function reaperLeaseSnapshot(db) {
    const [doc] = await collectionOf(db).aggregate([
        { $match: { _id: REAPER_LEASE_ID } },
        { $project: {
            holder: 1,
            live: { $gt: ['$expiresAt', '$$NOW'] },
            msLeft: { $subtract: ['$expiresAt', '$$NOW'] },
            nodeMarkerAgeMs: { $cond: [{ $ifNull: ['$participants.crmNode.at', false] }, { $subtract: ['$$NOW', '$participants.crmNode.at'] }, null] },
            nodeMarkerHolder: { $ifNull: ['$participants.crmNode.holder', null] }
        } }
    ]).toArray();
    if (!doc) return { exists: false };
    return { exists: true, holder: doc.holder ?? null, live: !!doc.live, msLeft: Number(doc.msLeft), nodeMarkerAgeMs: doc.nodeMarkerAgeMs == null ? null : Number(doc.nodeMarkerAgeMs), nodeMarkerHolder: doc.nodeMarkerHolder };
}

/**
 * Posse com token. Mesma semântica de crmeventstore.Lease (Go).
 */
export function createReaperLease({ db, holder = defaultReaperHolder(), ttlMs = DEFAULT_REAPER_LEASE_TTL_MS } = {}) {
    const coll = () => collectionOf(db);
    let token = '';
    const setPipeline = (tok) => [{ $set: { holder, token: tok, expiresAt: { $add: ['$$NOW', ttlMs] }, renewedAt: '$$NOW' } }];

    return {
        holder,
        ttlMs,
        get token() { return token; },

        /** Renova a posse viva, toma uma vencida (token novo) ou cria. false = outro dono vivo. */
        async acquire() {
            if (token) {
                const r = await coll().updateOne({ _id: REAPER_LEASE_ID, token, ...LIVE }, setPipeline(token));
                if (r.matchedCount === 1) return true;
            }
            try {
                // Nasce vencido: upsert não aceita o $expr e insert não usa o relógio do servidor.
                await coll().insertOne({ _id: REAPER_LEASE_ID, expiresAt: new Date(0) });
            } catch (e) {
                if (e?.code !== 11000) throw e;
            }
            const tok = randomUUID().replace(/-/g, '');
            const r = await coll().updateOne({ _id: REAPER_LEASE_ID, ...EXPIRED }, setPipeline(tok));
            if (r.matchedCount === 0) { token = ''; return false; }
            token = tok;
            return true;
        },

        /** Dentro da transação da escrita: confirma que a posse ainda é desta execução. */
        async fence(session) {
            if (!token) throw new ReaperLeaseLostError('sem posse');
            const r = await coll().updateOne(
                { _id: REAPER_LEASE_ID, token, ...LIVE },
                [{ $set: { fencedWriteAt: '$$NOW' } }],
                { session }
            );
            if (r.matchedCount === 0) { token = ''; throw new ReaperLeaseLostError('fence'); }
        },

        /** Devolve a posse (parada limpa). */
        async release() {
            if (!token) return;
            const t = token;
            token = '';
            await coll().updateOne({ _id: REAPER_LEASE_ID, token: t }, { $set: { expiresAt: new Date(0) } });
        }
    };
}
