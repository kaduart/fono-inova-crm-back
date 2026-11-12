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

/** Mesmo texto do botão "Oferecer particular" da tela (valor antes do preço, horário genérico). */
export function buildPrivateOfferText({ name, convenio, especialidade }) {
    const esp = especialidade ? ` de ${String(especialidade).toLowerCase()}` : '';
    const oi = !name || name === PLACEHOLDER_NAME ? 'Oi!' : `Oi, ${capitalize(firstName(name))}!`;
    const label = CONVENIO_LABELS[convenio] || convenio;
    return `${oi} Aqui é da Clínica Fono Inova. O credenciamento com o ${label} ainda está em andamento e não queremos que vocês fiquem esperando. `
        + `Começar cedo faz diferença no desenvolvimento, então dá para iniciar o atendimento${esp} no particular e passar para o plano quando ele sair. `
        + 'No pacote de 1x por semana cada sessão sai por R$ 180 (cerca de R$ 720 por mês). Tenho horário quinta de manhã ou amanhã à tarde. Quer que eu reserve? 💚';
}

/** Novidade: o convênio foi credenciado. Só as especialidades liberadas, se a equipe informar. */
export function buildAccreditedText({ name, convenio, especialidades = '' }) {
    const oi = !name || name === PLACEHOLDER_NAME ? 'Oi!' : `Oi, ${capitalize(firstName(name))}!`;
    const label = CONVENIO_LABELS[convenio] || convenio;
    const esp = String(especialidades || '').trim();
    return `${oi} Aqui é da Clínica Fono Inova. Você tinha procurado a gente pelo ${label} e temos uma boa notícia: `
        + `agora atendemos pelo ${label}${esp ? ` em ${esp.toLowerCase()}` : ''}! `
        + 'Assim dá para começar o acompanhamento com a nossa equipe usando o seu plano. '
        + 'Tenho horário quinta de manhã ou amanhã à tarde. Quer que eu reserve? 💚';
}

export const BULK_KINDS = {
    particular: { field: 'offer', statuses: ['aguardando'], skipWithSession: true, purpose: 'convenio_offer' },
    credenciado: { field: 'announce', statuses: ['aguardando', 'contatado'], skipWithSession: false, purpose: 'convenio_announce' },
};

const buildText = (kind, g, opts) => (kind === 'credenciado' ? buildAccreditedText({ ...g, ...opts }) : buildPrivateOfferText(g));

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
export async function planBulkOffer({ kind = 'particular', convenio = null, especialidades = '', now = new Date() } = {}) {
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
        sample: targets[0] ? buildText(kind, targets[0], { especialidades }) : null,
    };
}

/**
 * Enfileira o lote (idempotente: <campo>.queuedAt marcado antes; jobId por cadastro e tipo).
 * @returns {Promise<{ queued: number, failed: number }>}
 */
export async function enqueueBulkOffer({ kind = 'particular', batch, queue, userId = null, especialidades = '', now = new Date() }) {
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
                message: buildText(kind, g, { especialidades }),
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
