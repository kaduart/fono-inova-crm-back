// services/convenioWaitlistOffer.js
// Envio em massa para a lista de interesse em convênio, dois tipos:
//  - 'particular': oferta do particular enquanto o credenciamento não sai (campo `offer`);
//  - 'credenciado': novidade "agora atendemos o plano", só depois do credenciamento confirmado (campo `announce`).
// Envio pelo WhatsApp Web (chip da clínica) → DEVAGAR para não ser bloqueado: 1 a cada ~90s,
// no máximo OFFER_DAILY_CAP por dia e só dentro do horário do worker. Ver docs/flows/convenio_interest_whatsapp.md.
import ConvenioWaitlist from '../models/ConvenioWaitlist.js';
import { CONVENIO_LABELS } from '../constants/convenioWaitlist.js';
import { patientMatchesByPhone } from './convenioWaitlistWhatsapp.js';

export const OFFER_DAILY_CAP = Number(process.env.CONVENIO_OFFER_DAILY_CAP || 40);
export const OFFER_SPACING_MS = 90_000;          // intervalo médio entre mensagens
const OFFER_JITTER_MS = 30_000;                  // ± aleatório: não parecer robô
const WINDOW_START_MIN = 8 * 60;                 // 08:00 (America/Sao_Paulo)
const WINDOW_END_MIN = 18 * 60 + 45;             // 18:45 — worker desliga 19:10 (ADR-022)
const PLACEHOLDER_NAME = 'Contato do WhatsApp';

const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);

const greetName = (name) => (!name || name === PLACEHOLDER_NAME ? '' : `, ${capitalize(firstName(name))}`);
const cleanText = (v, max = 60) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * "Retomar contato" (texto do Kadu, 12/11/2026). Negrito no formato do WhatsApp (*texto*).
 * Sem atendente → "Aqui é da Clínica"; sem especialidade → "esse acompanhamento".
 */
export function buildPrivateOfferText({ name, convenio, especialidade, atendente = '' }) {
    const label = CONVENIO_LABELS[convenio] || convenio;
    const quem = cleanText(atendente, 40);
    const esp = cleanText(especialidade);
    return [
        `Oi${greetName(name)}! Tudo bem? 🥰💚`,
        '',
        quem ? `Aqui é a ${quem}, da *Clínica Fono Inova!*` : 'Aqui é da *Clínica Fono Inova!*',
        '',
        '✨ *Temos novidades por aqui e lembramos de você!*',
        '',
        `Há um tempinho, você conversou com a nossa equipe sobre atendimento pelo *${label}*, lembra?`,
        '',
        esp
            ? `Estamos ampliando nossas opções de atendimento e gostaríamos muito de saber se você ainda está procurando acompanhamento em *${esp.toLowerCase()}*. 💚`
            : 'Estamos ampliando nossas opções de atendimento e gostaríamos muito de saber se você ainda está procurando esse acompanhamento. 💚',
        '',
        'Será um prazer ajudar você e sua família!',
        '',
        '*Me conta, ainda podemos te ajudar com esse atendimento?* 😊',
    ].join('\n');
}

/** "Agora atendemos" (texto do Kadu, 12/11/2026). Só depois do credenciamento confirmado. */
export function buildAccreditedText({ name, convenio, especialidades = '' }) {
    const label = CONVENIO_LABELS[convenio] || convenio;
    const esp = cleanText(especialidades, 120);
    return [
        `Oi${greetName(name)}! Tudo bem? 🥰💚`,
        '',
        'Aqui é da *Clínica Fono Inova!*',
        '',
        '🎉 *Viemos compartilhar uma novidade maravilhosa com você!*',
        '',
        `Lembra que você procurou nossa clínica para atendimento pelo *${label}*?`,
        '',
        `Pois temos uma ótima notícia: *agora estamos atendendo pelo ${label}${esp ? ` em ${esp.toLowerCase()}` : ''}!* 💚✨`,
        '',
        'E como você já havia demonstrado interesse, fizemos questão de entrar em contato!',
        '',
        '*Você ainda está procurando esse atendimento?* Será uma alegria receber vocês! 🥰',
    ].join('\n');
}

export const BULK_KINDS = {
    particular: { field: 'offer', statuses: ['aguardando'], skipWithSession: true, purpose: 'convenio_offer' },
    credenciado: { field: 'announce', statuses: ['aguardando', 'contatado'], skipWithSession: false, purpose: 'convenio_announce' },
};

const buildText = (kind, g, opts) => (kind === 'credenciado' ? buildAccreditedText({ ...g, ...opts }) : buildPrivateOfferText({ ...g, atendente: opts?.atendente }));

/** Minutos do dia em São Paulo (sem horário de verão desde 2019) e se é dia útil. */
function spClock(now) {
    const sp = new Date(now.getTime() - 3 * 3600 * 1000);
    return { minutes: sp.getUTCHours() * 60 + sp.getUTCMinutes(), weekday: sp.getUTCDay(), dayStartUtc: new Date(Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate()) + 3 * 3600 * 1000) };
}

/** Quantas mensagens ainda cabem hoje (teto diário e janela de horário). */
export function offerCapacity({ now = new Date(), sentToday = 0 } = {}) {
    const { minutes, weekday } = spClock(now);
    if (weekday === 0 || weekday === 6) return { capacity: 0, reason: 'fim_de_semana' };
    if (minutes < WINDOW_START_MIN) return { capacity: 0, reason: 'antes_do_horario' };
    const left = OFFER_DAILY_CAP - sentToday;
    if (left <= 0) return { capacity: 0, reason: 'limite_diario' };
    const fits = Math.floor(((WINDOW_END_MIN - minutes) * 60_000) / (OFFER_SPACING_MS + OFFER_JITTER_MS / 2));
    if (fits <= 0) return { capacity: 0, reason: 'fim_do_horario' };
    return { capacity: Math.min(left, fits), reason: left <= fits ? 'limite_diario' : 'fim_do_horario' };
}

/**
 * Quem recebe: status do tipo (particular: aguardando; credenciado: aguardando/contatado), ainda sem esse envio,
 * 1 mensagem por telefone (o cadastro mais antigo). No particular, pula quem já tem sessão futura.
 * O teto diário vale para os dois tipos somados (é o mesmo chip). Mais antigos primeiro.
 */
export async function planBulkOffer({ kind = 'particular', convenio = null, especialidades = '', atendente = '', now = new Date() } = {}) {
    const cfg = BULK_KINDS[kind];
    if (!cfg) throw new Error(`Tipo de envio inválido: ${kind}`);
    const filter = { status: { $in: cfg.statuses }, [`${cfg.field}.queuedAt`]: null };
    if (convenio) filter.convenio = convenio;
    const rows = await ConvenioWaitlist.find(filter)
        .select('_id name phone convenio especialidade createdAt')
        .sort({ createdAt: 1 })
        .lean();

    const byPhone = new Map();
    for (const r of rows) {
        const g = byPhone.get(r.phone);
        if (g) g.ids.push(r._id);
        else byPhone.set(r.phone, { ...r, ids: [r._id] });
    }
    const withSession = [];
    const targets = [];
    const matches = cfg.skipWithSession ? await patientMatchesByPhone([...byPhone.keys()]) : new Map();
    for (const g of byPhone.values()) {
        if (matches.get(g.phone)?.nextAppointmentAt) withSession.push(g);
        else targets.push(g);
    }

    const { dayStartUtc } = spClock(now);
    const sentToday = await ConvenioWaitlist.countDocuments({
        $or: [{ 'offer.queuedAt': { $gte: dayStartUtc } }, { 'announce.queuedAt': { $gte: dayStartUtc } }],
    });
    const { capacity, reason } = offerCapacity({ now, sentToday });
    return {
        kind,
        eligible: targets.length,
        skippedWithSession: withSession.length,
        sentToday,
        capacity,
        limitReason: reason,
        batch: targets.slice(0, capacity),
        sample: targets[0] ? buildText(kind, targets[0], { especialidades, atendente }) : null,
    };
}

/**
 * Enfileira o lote (idempotente: <campo>.queuedAt marcado antes; jobId por cadastro e tipo).
 * @returns {Promise<{ queued: number, failed: number }>}
 */
export async function enqueueBulkOffer({ kind = 'particular', batch, queue, userId = null, especialidades = '', atendente = '', now = new Date() }) {
    const cfg = BULK_KINDS[kind];
    if (!cfg) throw new Error(`Tipo de envio inválido: ${kind}`);
    const f = cfg.field;
    let queued = 0;
    let failed = 0;
    let delay = 0;
    for (const g of batch) {
        // Marca antes de enfileirar: dois cliques simultâneos não mandam duas vezes para a mesma pessoa.
        const claim = await ConvenioWaitlist.updateMany(
            { _id: { $in: g.ids }, [`${f}.queuedAt`]: null },
            { $set: { [`${f}.queuedAt`]: now, [`${f}.queuedBy`]: userId } },
        );
        if (!claim.modifiedCount) continue;
        try {
            await queue.add('send-message', {
                phone: g.phone,
                message: buildText(kind, g, { especialidades, atendente }),
                purpose: cfg.purpose,
                waitlistIds: g.ids.map(String),
            }, {
                jobId: `${cfg.purpose.replace('_', '-')}-${g._id}`,
                delay,
                attempts: 3,
                backoff: { type: 'exponential', delay: 60_000 },
                removeOnComplete: 500,
                removeOnFail: 500,
            });
            queued++;
            delay += OFFER_SPACING_MS + Math.round((Math.random() - 0.5) * OFFER_JITTER_MS);
        } catch (err) {
            failed++;
            await ConvenioWaitlist.updateMany({ _id: { $in: g.ids } }, { $set: { [`${f}.queuedAt`]: null, [`${f}.queuedBy`]: null } });
            console.error('[ConvenioEnvio] ❌ falha ao enfileirar', { kind, tail: String(g.phone).slice(-4), err: err.message });
        }
    }
    console.log(`[ConvenioEnvio] 📤 ${kind}: ${queued} enfileiradas (1 a cada ~${OFFER_SPACING_MS / 1000}s), ${failed} falhas, user=${userId}`);
    return { queued, failed };
}

const fieldForPurpose = (purpose) => Object.values(BULK_KINDS).find((k) => k.purpose === purpose)?.field || 'offer';

/** Chamado pelo worker depois que a mensagem saiu: marca enviado e passa para 'contatado'. */
export async function markOfferSent(waitlistIds = [], { purpose = 'convenio_offer', messageId = null, at = new Date() } = {}) {
    if (!waitlistIds.length) return;
    const f = fieldForPurpose(purpose);
    await ConvenioWaitlist.updateMany({ _id: { $in: waitlistIds } }, { $set: { [`${f}.sentAt`]: at, [`${f}.messageId`]: messageId } });
    await ConvenioWaitlist.updateMany(
        { _id: { $in: waitlistIds }, status: 'aguardando' },
        { $set: { status: 'contatado', notifiedAt: at } },
    );
}

/** Falha definitiva (sem WhatsApp, número inválido): registra para a equipe ver. */
export async function markOfferFailed(waitlistIds = [], error = '', purpose = 'convenio_offer') {
    if (!waitlistIds.length) return;
    const f = fieldForPurpose(purpose);
    await ConvenioWaitlist.updateMany({ _id: { $in: waitlistIds } }, { $set: { [`${f}.error`]: String(error).slice(0, 200) } });
}

/**
 * Envio individual (botões da linha): monta o texto do tipo ou usa o texto editado pela equipe,
 * enfileira na hora (sem atraso) e marca o campo do tipo. Pode reenviar: é a equipe decidindo.
 */
export async function sendSingle({ entry, kind = 'particular', message = '', especialidades = '', atendente = '', queue, userId = null, now = new Date() }) {
    const cfg = BULK_KINDS[kind];
    if (!cfg) throw new Error(`Tipo de envio inválido: ${kind}`);
    const text = String(message || '').trim() || buildText(kind, entry, { especialidades, atendente });
    const job = await queue.add('send-message', {
        phone: entry.phone,
        message: text,
        purpose: cfg.purpose,
        waitlistIds: [String(entry._id)],
    }, { attempts: 3, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: 500, removeOnFail: 500 });
    await ConvenioWaitlist.updateOne(
        { _id: entry._id },
        { $set: { [`${cfg.field}.queuedAt`]: now, [`${cfg.field}.queuedBy`]: userId, [`${cfg.field}.error`]: null } },
    );
    console.log(`[ConvenioEnvio] 📤 individual ${kind} enfileirado`, { tail: String(entry.phone).slice(-4), jobId: job.id, userId });
    return { jobId: job.id, message: text };
}

export const previewSingle = ({ entry, kind = 'particular', especialidades = '', atendente = '' }) =>
    buildText(kind, entry, { especialidades, atendente });
