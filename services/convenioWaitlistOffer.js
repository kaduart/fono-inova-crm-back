// services/convenioWaitlistOffer.js
// Envio em massa para a lista de interesse em convênio, dois tipos:
//  - 'particular': oferta do particular enquanto o credenciamento não sai (campo `offer`);
//  - 'credenciado': novidade "agora atendemos o plano", só depois do credenciamento confirmado (campo `announce`).
// Envio pelo WhatsApp Web (chip da clínica) → DEVAGAR para não ser bloqueado: 1 a cada ~90s,
// no máximo OFFER_DAILY_CAP por dia e só dentro do horário do worker. Ver docs/flows/convenio_interest_whatsapp.md.
import ConvenioWaitlist from '../models/ConvenioWaitlist.js';
import EvaluationReengagement from '../models/EvaluationReengagement.js';
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

// recentDays: se a clínica mandou QUALQUER mensagem para a pessoa nesse período (na mão, lembrete, outro envio),
// ela fica de fora do envio em massa. A novidade do credenciamento tem janela menor: é notícia nova.
export const BULK_KINDS = {
    particular: { field: 'offer', statuses: ['aguardando'], skipWithSession: true, purpose: 'convenio_offer', recentDays: Number(process.env.CONVENIO_OFFER_RECENT_DAYS || 30) },
    credenciado: { field: 'announce', statuses: ['aguardando', 'contatado'], skipWithSession: false, purpose: 'convenio_announce', recentDays: Number(process.env.CONVENIO_ANNOUNCE_RECENT_DAYS || 7) },
};

const DAY_MS = 24 * 3600 * 1000;
const RECIPIENTS_MAX = 400; // a tela lista quem vai receber e quem fica de fora

const phoneTail = (p) => String(p || '').slice(-4);
const personView = (g, extra = {}) => ({
    id: String(g._id),
    name: g.name,
    phoneTail: phoneTail(g.phone),
    convenio: g.convenio,
    since: g.whatsapp?.lastMentionAt || g.createdAt || null,
    lastClinicMessageAt: g.whatsapp?.lastClinicMessageAt || null,
    ...extra,
});

const buildText = (kind, g, opts) => (kind === 'credenciado' ? buildAccreditedText({ ...g, ...opts }) : buildPrivateOfferText({ ...g, atendente: opts?.atendente }));

/** Minutos do dia em São Paulo (sem horário de verão desde 2019) e se é dia útil. */
export function spClock(now) {
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

export const spDayKey = (d) => new Date(d.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);

/**
 * Horários de envio espalhados em dias úteis (08:00–18:45 SP), ~90s ±15s entre mensagens e no máximo
 * OFFER_DAILY_CAP por dia, contando o que já está agendado/enviado em cada dia (`busy`: datas já ocupadas).
 * Assim um clique manda para todo mundo: 40 hoje, 40 no próximo dia útil e assim por diante.
 * @returns {Date[]}
 */
export function scheduleSlots({ count, now = new Date(), busy = [], random = Math.random }) {
    const perDay = new Map();
    let last = 0;
    for (const d of busy) {
        const k = spDayKey(d);
        perDay.set(k, (perDay.get(k) || 0) + 1);
        if (d.getTime() > last) last = d.getTime();
    }
    const slots = [];
    let t = Math.max(now.getTime(), last + OFFER_SPACING_MS);
    for (let guard = 0; slots.length < count && guard < 10_000; guard++) {
        const cur = new Date(t);
        const { minutes, weekday, dayStartUtc } = spClock(cur);
        const nextDay8 = dayStartUtc.getTime() + 24 * 3600 * 1000 + WINDOW_START_MIN * 60_000;
        if (weekday === 0 || weekday === 6 || minutes >= WINDOW_END_MIN || (perDay.get(spDayKey(cur)) || 0) >= OFFER_DAILY_CAP) {
            t = nextDay8;
            continue;
        }
        if (minutes < WINDOW_START_MIN) {
            t = dayStartUtc.getTime() + WINDOW_START_MIN * 60_000;
            continue;
        }
        slots.push(cur);
        perDay.set(spDayKey(cur), (perDay.get(spDayKey(cur)) || 0) + 1);
        t += OFFER_SPACING_MS + Math.round((random() - 0.5) * OFFER_JITTER_MS);
    }
    return slots;
}

/**
 * Datas já ocupadas (agendadas ou enviadas) de hoje em diante, de TODO envio em massa pelo chip:
 * os dois tipos de convênio e o "Retomar contato" pós-avaliação (EvaluationReengagement).
 * O teto de OFFER_DAILY_CAP por dia vale para a soma.
 */
export async function busySlots(now) {
    const { dayStartUtc } = spClock(now);
    const docs = await ConvenioWaitlist.find({
        $or: [
            { 'offer.queuedAt': { $gte: dayStartUtc } }, { 'offer.scheduledFor': { $gte: dayStartUtc } },
            { 'announce.queuedAt': { $gte: dayStartUtc } }, { 'announce.scheduledFor': { $gte: dayStartUtc } },
        ],
    }).select('offer.queuedAt offer.scheduledFor offer.skippedAt announce.queuedAt announce.scheduledFor announce.skippedAt').lean();
    const out = [];
    const reengage = await EvaluationReengagement.find({
        skippedAt: null,
        $or: [{ queuedAt: { $gte: dayStartUtc } }, { scheduledFor: { $gte: dayStartUtc } }],
    }).select('queuedAt scheduledFor').lean();
    for (const r of reengage) {
        const at = r.scheduledFor || r.queuedAt;
        if (at && new Date(at) >= dayStartUtc) out.push(new Date(at));
    }
    for (const d of docs) {
        for (const f of ['offer', 'announce']) {
            const info = d[f];
            if (!info || info.skippedAt) continue;
            const at = info.scheduledFor || info.queuedAt;
            if (at && new Date(at) >= dayStartUtc) out.push(new Date(at));
        }
    }
    return out;
}

/**
 * Quem recebe: status do tipo (particular: aguardando; credenciado: aguardando/contatado), ainda sem esse envio,
 * 1 mensagem por telefone (o cadastro mais antigo). Fica de fora (e a tela mostra o motivo):
 *  - quem já recebeu esta mensagem (ou está na fila);
 *  - quem conversou com a clínica nos últimos `recentDays` dias (mensagem da clínica, inclusive manual);
 *  - no particular, quem já tem sessão futura; e quem a equipe marcou como Contatado.
 * `excludeIds` = pessoas que a equipe desmarcou na tela. O teto diário vale para os dois tipos somados.
 */
export async function planBulkOffer({ kind = 'particular', convenio = null, especialidades = '', atendente = '', excludeIds = [], now = new Date() } = {}) {
    const cfg = BULK_KINDS[kind];
    if (!cfg) throw new Error(`Tipo de envio inválido: ${kind}`);
    const base = convenio ? { convenio } : {};
    const rows = await ConvenioWaitlist.find({ ...base, status: { $in: cfg.statuses }, [`${cfg.field}.queuedAt`]: null })
        .select('_id name phone convenio especialidade createdAt whatsapp.lastMentionAt whatsapp.lastClinicMessageAt')
        .sort({ createdAt: 1 })
        .lean();

    const byPhone = new Map();
    for (const r of rows) {
        const g = byPhone.get(r.phone);
        if (g) {
            g.ids.push(r._id);
            const at = r.whatsapp?.lastClinicMessageAt;
            if (at && (!g.whatsapp?.lastClinicMessageAt || at > g.whatsapp.lastClinicMessageAt)) g.whatsapp = { ...g.whatsapp, lastClinicMessageAt: at };
        } else byPhone.set(r.phone, { ...r, ids: [r._id] });
    }

    const recentSince = new Date(now.getTime() - cfg.recentDays * DAY_MS);
    const excluded = new Set((excludeIds || []).map(String));
    const matches = cfg.skipWithSession ? await patientMatchesByPhone([...byPhone.keys()]) : new Map();
    const skipped = [];
    const targets = [];
    let unchecked = 0;
    for (const g of byPhone.values()) {
        const lastClinic = g.whatsapp?.lastClinicMessageAt ? new Date(g.whatsapp.lastClinicMessageAt) : null;
        if (matches.get(g.phone)?.nextAppointmentAt) skipped.push(personView(g, { reason: 'sessao_futura' }));
        else if (lastClinic && lastClinic >= recentSince) skipped.push(personView(g, { reason: 'conversa_recente' }));
        else if (excluded.has(String(g._id))) { unchecked++; targets.push({ ...g, excluded: true }); }
        else targets.push(g);
    }

    const [alreadySent, markedContatado] = await Promise.all([
        ConvenioWaitlist.countDocuments({ ...base, [`${cfg.field}.queuedAt`]: { $ne: null } }),
        cfg.statuses.includes('contatado') ? 0 : ConvenioWaitlist.countDocuments({ ...base, status: 'contatado', [`${cfg.field}.queuedAt`]: null }),
    ]);

    const busy = await busySlots(now);
    const todayKey = spDayKey(now);
    const sentToday = busy.filter((d) => spDayKey(d) === todayKey && d <= now).length;
    const { capacity, reason } = offerCapacity({ now, sentToday: busy.filter((d) => spDayKey(d) === todayKey).length });
    const sendable = targets.filter((g) => !g.excluded);
    // Um clique manda para todos: o lote inteiro é agendado em dias úteis (teto por dia).
    const slots = scheduleSlots({ count: sendable.length, now, busy, random: () => 0.5 });
    const batch = sendable.slice(0, slots.length);
    const today = new Set(batch.filter((g, i) => spDayKey(slots[i]) === todayKey).map((g) => String(g._id)));
    const days = new Set(slots.map(spDayKey));
    const lastSlot = slots.at(-1) || null;
    return {
        kind,
        eligible: sendable.length,
        unchecked,
        skippedWithSession: skipped.filter((p) => p.reason === 'sessao_futura').length,
        skippedRecentChat: skipped.filter((p) => p.reason === 'conversa_recente').length,
        alreadySent,
        markedContatado,
        recentDays: cfg.recentDays,
        sentToday,
        capacity,
        limitReason: reason,
        todayCount: today.size,
        days: days.size,
        finishesAt: lastSlot,
        batch,
        recipients: targets.slice(0, RECIPIENTS_MAX).map((g) => {
            const i = batch.indexOf(g);
            return personView(g, { today: today.has(String(g._id)), excluded: Boolean(g.excluded), scheduledFor: i >= 0 ? slots[i] : null });
        }),
        skipped: skipped.slice(0, RECIPIENTS_MAX),
        sample: sendable[0] ? buildText(kind, sendable[0], { especialidades, atendente }) : null,
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
    const slots = scheduleSlots({ count: batch.length, now, busy: await busySlots(now) });
    let queued = 0;
    let failed = 0;
    for (let i = 0; i < batch.length && i < slots.length; i++) {
        const g = batch[i];
        const at = slots[i];
        // Marca antes de enfileirar: dois cliques simultâneos não mandam duas vezes para a mesma pessoa.
        const claim = await ConvenioWaitlist.updateMany(
            { _id: { $in: g.ids }, [`${f}.queuedAt`]: null },
            { $set: { [`${f}.queuedAt`]: now, [`${f}.queuedBy`]: userId, [`${f}.scheduledFor`]: at } },
        );
        if (!claim.modifiedCount) continue;
        try {
            await queue.add('send-message', {
                phone: g.phone,
                message: buildText(kind, g, { especialidades, atendente }),
                purpose: cfg.purpose,
                waitlistIds: g.ids.map(String),
                // O worker confere a conversa no WhatsApp logo antes de mandar: se a clínica falou com a pessoa
                // nesse período (ex.: a secretária respondeu na mão depois da prévia), não manda.
                recentDays: cfg.recentDays,
            }, {
                jobId: `${cfg.purpose.replace('_', '-')}-${g._id}`,
                delay: Math.max(0, at.getTime() - now.getTime()),
                attempts: 3,
                backoff: { type: 'exponential', delay: 60_000 },
                removeOnComplete: 500,
                removeOnFail: 500,
            });
            queued++;
        } catch (err) {
            failed++;
            await ConvenioWaitlist.updateMany({ _id: { $in: g.ids } }, { $set: { [`${f}.queuedAt`]: null, [`${f}.queuedBy`]: null, [`${f}.scheduledFor`]: null } });
            console.error('[ConvenioEnvio] ❌ falha ao enfileirar', { kind, tail: String(g.phone).slice(-4), err: err.message });
        }
    }
    const last = slots[Math.min(batch.length, slots.length) - 1];
    console.log(`[ConvenioEnvio] 📤 ${kind}: ${queued} agendadas (até ${OFFER_DAILY_CAP}/dia útil, último ${last?.toISOString() || '-'}), ${failed} falhas, user=${userId}`);
    return { queued, failed, finishesAt: last || null };
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

/** Não enviado de propósito (conversa recente com a clínica): registra o motivo; não conta no teto do dia. */
export async function markOfferSkipped(waitlistIds = [], { purpose = 'convenio_offer', reason = '', lastClinicAt = null, at = new Date() } = {}) {
    if (!waitlistIds.length) return;
    const f = fieldForPurpose(purpose);
    await ConvenioWaitlist.updateMany(
        { _id: { $in: waitlistIds } },
        {
            $set: { [`${f}.skippedAt`]: at, [`${f}.skipReason`]: String(reason).slice(0, 200) },
            ...(lastClinicAt ? { $max: { 'whatsapp.lastClinicMessageAt': lastClinicAt } } : {}),
        },
    );
}

/**
 * Trava do worker, logo antes de mandar: a clínica já falou com a pessoa nos últimos `recentDays` dias?
 * @param {{ clinicAt: Date|null }} activity resultado de getChatActivity
 */
export function isRecentClinicChat(activity, recentDays, now = new Date()) {
    if (!activity?.clinicAt || !recentDays) return false;
    return activity.clinicAt.getTime() >= now.getTime() - recentDays * DAY_MS;
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
        { $set: { [`${cfg.field}.queuedAt`]: now, [`${cfg.field}.queuedBy`]: userId, [`${cfg.field}.error`]: null, [`${cfg.field}.skippedAt`]: null, [`${cfg.field}.skipReason`]: null } },
    );
    console.log(`[ConvenioEnvio] 📤 individual ${kind} enfileirado`, { tail: String(entry.phone).slice(-4), jobId: job.id, userId });
    return { jobId: job.id, message: text };
}

export const previewSingle = ({ entry, kind = 'particular', especialidades = '', atendente = '' }) =>
    buildText(kind, entry, { especialidades, atendente });
