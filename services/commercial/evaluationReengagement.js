// services/commercial/evaluationReengagement.js
/**
 * "Retomar contato" com quem fez avaliação e não deu continuidade (Kadu, 12/11/2026).
 *
 * Quem entra: avaliação realizada (tipo avaliação OU o primeiro atendimento realizado do paciente, qualquer forma
 * de pagamento; ver findEvaluationLike) e, DEPOIS dela, nenhuma sessão (realizada ou marcada) e nenhum pacote. Período:
 *  - 'all': todo o histórico (primeiro envio), só não pega avaliação dos últimos ALL_MIN_DAYS dias;
 *  - 15 | 30 | 60: avaliou há mais de N dias.
 *
 * Reaproveita o motor do envio em massa da lista de convênios (services/convenioWaitlistOffer.js):
 * mesmo chip, mesma fila `whatsapp-send`, 1 mensagem a cada ~90s, teto diário somado (40) e só dia útil 08:00–18:45.
 * Não repete: 1 mensagem por telefone e por avaliação (EvaluationReengagement), pula quem conversou com a
 * clínica nos últimos RECENT_DAYS dias e o worker confere a conversa de novo logo antes de cada envio.
 *
 * Só leitura em Appointment/Patient/Package/Message/CommercialContact. Escrita só em EvaluationReengagement.
 * Ver docs/flows/evaluation_reengagement.md.
 */
import moment from 'moment-timezone';
import Appointment from '../../models/Appointment.js';
import Patient from '../../models/Patient.js';
import Package from '../../models/Package.js';
import Message from '../../models/Message.js';
import CommercialContact from '../../models/CommercialContact.js';
import EvaluationReengagement from '../../models/EvaluationReengagement.js';
import { canonicalPhone, isRealBRPhone, phoneVariants } from '../convenioWaitlistWhatsapp.js';
import { scheduleSlots, busySlots, offerCapacity, spDayKey, OFFER_DAILY_CAP } from '../convenioWaitlistOffer.js';
import { findEvaluationLike } from './evaluationConfirmationQueues.js';
import { FUTURE_STATUSES } from './commercialRules.js';

const TIMEZONE = 'America/Sao_Paulo';
const DAY_MS = 24 * 3600 * 1000;
export const PURPOSE = 'evaluation_reengage';
export const PERIODS = ['all', 15, 30, 60];
export const ALL_MIN_DAYS = 3; // igual ao início da fila "Avaliou e não fechou"
export const RECENT_DAYS = Number(process.env.EVALUATION_REENGAGE_RECENT_DAYS || 30);
const RECIPIENTS_MAX = 600;
// Depois da avaliação, isto conta como "deu continuidade" (realizada, marcada ou em processamento).
// Cancelada, falta e suspensa não contam: quem só desmarcou também sumiu.
const CONTINUITY_STATUSES = ['completed', 'paid', 'scheduled', 'confirmed', 'pre_agendado', 'pending', 'processing_create', 'processing_complete'];

const SPECIALTY_TEXT = {
    fonoaudiologia: 'fonoaudiologia',
    psicologia: 'psicologia',
    terapia_ocupacional: 'terapia ocupacional',
    fisioterapia: 'fisioterapia',
    psicopedagogia: 'psicopedagogia',
    psicomotricidade: 'psicomotricidade',
    musicoterapia: 'musicoterapia',
    neuropsych_evaluation: 'neuropsicologia',
    neuropsicologia: 'neuropsicologia',
    tongue_tie_test: 'teste da linguinha',
    pediatria: 'pediatria',
    neuroped: 'neuropediatria',
};

const firstName = (name) => {
    const n = String(name || '').trim().split(/\s+/)[0] || '';
    return n ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : '';
};
const cleanText = (v, max = 40) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, max);
const joinNames = (names) => (names.length <= 1 ? names[0] || '' : `${names.slice(0, -1).join(', ')} e ${names.at(-1)}`);
const idStr = (v) => (v ? String(v) : '');

/** Período da tela → minDays/maxDays. */
export function periodRange(period) {
    const p = period === 'all' || period == null ? 'all' : Number(period);
    if (p === 'all') return { period: 'all', minDays: ALL_MIN_DAYS, maxDays: null };
    if (!PERIODS.includes(p)) throw new Error(`Período inválido: ${period}`);
    return { period: p, minDays: p, maxDays: null };
}

/**
 * Texto (proposta 12/11/2026, aguardando o Kadu). Quem recebe costuma ser o responsável, não o paciente:
 * cumprimenta pelo responsável quando o cadastro tem, e cita o paciente pelo primeiro nome.
 */
export function buildReengageText({ patientNames = [], guardian = '', specialty = null, atendente = '' }) {
    const names = patientNames.map(firstName).filter(Boolean);
    const quem = cleanText(atendente);
    const esp = SPECIALTY_TEXT[specialty] || null;
    const g = firstName(guardian);
    const who = names.length ? ` com *${joinNames(names)}*` : '';
    return [
        `Oi${g ? `, ${g}` : ''}! Tudo bem? 🥰💚`,
        '',
        quem ? `Aqui é a ${quem}, da *Clínica Fono Inova!*` : 'Aqui é da *Clínica Fono Inova!*',
        '',
        `Há um tempinho fizemos a avaliação${esp ? ` de *${esp}*` : ''}${who} aqui na clínica e lembramos de vocês! ✨`,
        '',
        `Queríamos saber como ${names.length === 1 ? names[0] : names.length ? 'eles' : 'vocês'} ${names.length > 1 ? 'estão' : 'está'} e se ainda podemos ajudar a dar continuidade ao acompanhamento. 💚`,
        '',
        '*Me conta, podemos conversar sobre os próximos passos?* 😊',
    ].join('\n');
}

/**
 * Regra pura (testável): das avaliações (a mais recente de cada paciente), quem NÃO deu continuidade.
 * @returns {{ open: object[], future: Set<string> }}
 */
export function pickWithoutContinuity(evaluations, { later = [], packages = [], futurePatientIds = new Set() }) {
    const laterByPatient = new Map();
    for (const a of later) {
        const k = idStr(a.patient);
        if (!laterByPatient.has(k)) laterByPatient.set(k, []);
        laterByPatient.get(k).push(a);
    }
    const pkgByPatient = new Map();
    for (const p of packages) {
        const k = idStr(p.patient);
        if (!pkgByPatient.has(k)) pkgByPatient.set(k, []);
        pkgByPatient.get(k).push(p);
    }
    return evaluations.filter((ev) => {
        const pid = idStr(ev.patient);
        if (futurePatientIds.has(pid)) return false;
        const evDate = new Date(ev.date);
        const hasLater = (laterByPatient.get(pid) || []).some((a) => idStr(a._id) !== idStr(ev._id) && new Date(a.date) > evDate);
        if (hasLater) return false;
        return !(pkgByPatient.get(pid) || []).some((p) => {
            if (['active', 'in-progress'].includes(p.status)) return true;
            const created = p.createdAt ? new Date(p.createdAt) : p._id?.getTimestamp?.();
            return created && created >= new Date(evDate.getTime() - DAY_MS);
        });
    });
}

/** Avaliações sem continuidade no período (só leitura). */
export async function findWithoutContinuity({ minDays, maxDays = null, now = new Date() }) {
    const nowSp = moment(now).tz(TIMEZONE);
    const to = nowSp.clone().subtract(minDays, 'days').endOf('day').toDate();
    const dateFilter = { $lte: to };
    if (maxDays) dateFilter.$gte = nowSp.clone().subtract(maxDays, 'days').startOf('day').toDate();

    // Avaliação = tipo avaliação realizada OU primeiro atendimento realizado do paciente (ver findEvaluationLike).
    // Se depois dela houve outro atendimento (inclusive avaliação nova), o paciente não entra (continuidade).
    const evals = await findEvaluationLike({ from: dateFilter.$gte || null, to: dateFilter.$lte });
    if (!evals.length) return [];
    const pids = evals.map((e) => e.patient);
    const minEval = new Date(Math.min(...evals.map((e) => new Date(e.date).getTime())));
    const todayStart = nowSp.clone().startOf('day').toDate();

    const [later, packages, future] = await Promise.all([
        Appointment.find(
            { patient: { $in: pids }, isDeleted: { $ne: true }, date: { $gt: minEval }, operationalStatus: { $in: CONTINUITY_STATUSES } },
            { patient: 1, date: 1 },
        ).lean(),
        Package.find({ patient: { $in: pids }, status: { $ne: 'canceled' } }, { patient: 1, status: 1, createdAt: 1 }).lean(),
        Appointment.distinct('patient', { patient: { $in: pids }, isDeleted: { $ne: true }, date: { $gte: todayStart }, operationalStatus: { $in: FUTURE_STATUSES } }),
    ]);
    return pickWithoutContinuity(evals, { later, packages, futurePatientIds: new Set(future.map(String)) });
}

/** Última mensagem trocada (ERP, Amanda, lembrete) com cada telefone desde `since`, pela coleção Message. */
async function recentMessagesByPhone(phones, since) {
    const variants = new Map();
    for (const p of phones) for (const v of phoneVariants(p)) variants.set(v, p);
    if (!variants.size) return new Map();
    const all = [...variants.keys()];
    const rows = await Message.aggregate([
        { $match: { timestamp: { $gte: since }, $or: [{ to: { $in: all } }, { from: { $in: all } }] } },
        { $group: { _id: { to: '$to', from: '$from' }, at: { $max: '$timestamp' } } },
    ]);
    const out = new Map();
    for (const r of rows) {
        for (const k of [r._id.to, r._id.from]) {
            const p = variants.get(k);
            if (p && (!out.get(p) || r.at > out.get(p))) out.set(p, r.at);
        }
    }
    return out;
}

const phoneTail = (p) => String(p || '').slice(-4);

/**
 * Prévia + lote. Fica de fora (e a tela mostra o motivo): sem celular válido, paciente inativado,
 * marcado como "Não vai fechar", já recebeu (por esta avaliação) e conversa com a clínica nos últimos RECENT_DAYS dias.
 * `excludeIds` = ids (do primeiro paciente do telefone) que a equipe desmarcou.
 */
export async function planReengagement({ period = 'all', atendente = '', excludeIds = [], now = new Date() } = {}) {
    const range = periodRange(period);
    const open = await findWithoutContinuity({ ...range, now });

    const pids = open.map((e) => e.patient);
    const [patients, lost, sentDocs] = await Promise.all([
        Patient.find({ _id: { $in: pids } }, { fullName: 1, phone: 1, legalGuardian: 1, status: 1, inactivation: 1 }).lean(),
        CommercialContact.distinct('target', { target: { $in: pids }, kind: 'evaluation_lost' }),
        EvaluationReengagement.find({ evaluation: { $in: open.map((e) => e._id) } }).select('evaluation patient phone queuedAt sentAt skippedAt lastClinicMessageAt').lean(),
    ]);
    const pMap = new Map(patients.map((p) => [idStr(p._id), p]));
    const lostSet = new Set(lost.map(String));
    const sentByEval = new Map(sentDocs.map((d) => [idStr(d.evaluation), d]));

    const skipped = [];
    const byPhone = new Map();
    let alreadySent = 0;
    for (const ev of open.sort((a, b) => new Date(b.date) - new Date(a.date))) {
        const pt = pMap.get(idStr(ev.patient));
        if (!pt) continue;
        const view = { id: idStr(pt._id), name: pt.fullName, phoneTail: phoneTail(pt.phone), specialty: ev.specialty || null, since: ev.date };
        const doc = sentByEval.get(idStr(ev._id));
        if (doc?.queuedAt) { alreadySent++; continue; }
        const phone = canonicalPhone(pt.phone);
        if (!phone || !isRealBRPhone(phone)) { skipped.push({ ...view, reason: 'sem_telefone' }); continue; }
        if (pt.status === 'inactive') { skipped.push({ ...view, reason: 'inativo', detail: pt.inactivation?.reason || null }); continue; }
        if (lostSet.has(idStr(pt._id))) { skipped.push({ ...view, reason: 'nao_vai_fechar' }); continue; }
        const g = byPhone.get(phone);
        const item = { ev, pt, view, lastClinicMessageAt: doc?.lastClinicMessageAt || null };
        if (g) g.items.push(item);
        else byPhone.set(phone, { phone, items: [item] });
    }

    const recentSince = new Date(now.getTime() - RECENT_DAYS * DAY_MS);
    const recent = await recentMessagesByPhone([...byPhone.keys()], recentSince);
    const excluded = new Set((excludeIds || []).map(String));
    const targets = [];
    let unchecked = 0;
    for (const g of byPhone.values()) {
        const main = g.items[0];
        const lastChat = [recent.get(g.phone), ...g.items.map((i) => i.lastClinicMessageAt)].filter(Boolean).map((d) => new Date(d)).sort((a, b) => b - a)[0] || null;
        const names = g.items.map((i) => i.pt.fullName);
        const view = { ...main.view, name: joinNames(names), lastClinicMessageAt: lastChat };
        if (lastChat && lastChat >= recentSince) { skipped.push({ ...view, reason: 'conversa_recente' }); continue; }
        const specialties = new Set(g.items.map((i) => i.ev.specialty).filter(Boolean));
        const t = {
            id: main.view.id,
            phone: g.phone,
            items: g.items,
            view,
            text: (opts) => buildReengageText({
                patientNames: names,
                guardian: main.pt.legalGuardian,
                specialty: specialties.size === 1 ? [...specialties][0] : null,
                ...opts,
            }),
        };
        if (excluded.has(t.id)) { unchecked++; t.excluded = true; }
        targets.push(t);
    }
    // Quem sumiu há menos tempo primeiro: lembra melhor da clínica.
    targets.sort((a, b) => new Date(b.view.since) - new Date(a.view.since));

    const busy = await busySlots(now);
    const todayKey = spDayKey(now);
    const sentToday = busy.filter((d) => spDayKey(d) === todayKey && d <= now).length;
    const { capacity, reason } = offerCapacity({ now, sentToday: busy.filter((d) => spDayKey(d) === todayKey).length });
    const sendable = targets.filter((t) => !t.excluded);
    const slots = scheduleSlots({ count: sendable.length, now, busy, random: () => 0.5 });
    const batch = sendable.slice(0, slots.length);
    const slotById = new Map(batch.map((t, i) => [t.id, slots[i]]));
    const lastSlot = slots.at(-1) || null;
    const count = (r) => skipped.filter((p) => p.reason === r).length;
    return {
        ...range,
        eligible: sendable.length,
        unchecked,
        alreadySent,
        skippedRecentChat: count('conversa_recente'),
        skippedNoPhone: count('sem_telefone'),
        skippedInactive: count('inativo'),
        skippedLost: count('nao_vai_fechar'),
        recentDays: RECENT_DAYS,
        sentToday,
        capacity,
        limitReason: reason,
        todayCount: batch.filter((t) => spDayKey(slotById.get(t.id)) === todayKey).length,
        days: new Set(slots.map(spDayKey)).size,
        finishesAt: lastSlot,
        batch,
        recipients: targets.slice(0, RECIPIENTS_MAX).map((t) => {
            const at = slotById.get(t.id) || null;
            return { ...t.view, excluded: Boolean(t.excluded), scheduledFor: at, today: Boolean(at && spDayKey(at) === todayKey) };
        }),
        skipped: skipped.slice(0, RECIPIENTS_MAX),
        sample: sendable[0] ? sendable[0].text({ atendente }) : null,
    };
}

/**
 * Agenda o lote (idempotente: grava EvaluationReengagement.queuedAt ANTES de enfileirar, índice único por
 * avaliação e jobId fixo por avaliação). Dois cliques ao mesmo tempo não mandam duas vezes.
 */
export async function enqueueReengagement({ batch, queue, userId = null, atendente = '', now = new Date() }) {
    const slots = scheduleSlots({ count: batch.length, now, busy: await busySlots(now) });
    let queued = 0;
    let failed = 0;
    for (let i = 0; i < batch.length && i < slots.length; i++) {
        const t = batch[i];
        const at = slots[i];
        const evalIds = t.items.map((it) => it.ev._id);
        let claimed = 0;
        for (const it of t.items) {
            const res = await EvaluationReengagement.updateOne(
                { evaluation: it.ev._id, queuedAt: null },
                {
                    $set: { queuedAt: now, queuedBy: userId, scheduledFor: at, phone: t.phone, error: null },
                    $setOnInsert: { patient: it.pt._id, evaluatedAt: it.ev.date, specialty: it.ev.specialty || null },
                },
                { upsert: true },
            ).catch((err) => (err?.code === 11000 ? { modifiedCount: 0, upsertedCount: 0 } : Promise.reject(err)));
            claimed += (res.modifiedCount || 0) + (res.upsertedCount || 0);
        }
        if (!claimed) continue;
        try {
            await queue.add('send-message', {
                phone: t.phone,
                message: t.text({ atendente }),
                purpose: PURPOSE,
                reengageEvaluationIds: evalIds.map(String),
                // O worker confere a conversa logo antes de mandar (a equipe pode ter falado na mão depois da prévia).
                recentDays: RECENT_DAYS,
            }, {
                jobId: `evaluation-reengage-${evalIds[0]}`,
                delay: Math.max(0, at.getTime() - now.getTime()),
                attempts: 3,
                backoff: { type: 'exponential', delay: 60_000 },
                removeOnComplete: 500,
                removeOnFail: 500,
            });
            queued++;
        } catch (err) {
            failed++;
            await EvaluationReengagement.updateMany({ evaluation: { $in: evalIds } }, { $set: { queuedAt: null, queuedBy: null, scheduledFor: null } });
            console.error('[RetomarAvaliacao] ❌ falha ao enfileirar', { tail: phoneTail(t.phone), err: err.message });
        }
    }
    const last = slots[Math.min(batch.length, slots.length) - 1] || null;
    console.log(`[RetomarAvaliacao] 📤 ${queued} agendadas (até ${OFFER_DAILY_CAP}/dia útil, último ${last?.toISOString() || '-'}), ${failed} falhas, user=${userId}`);
    return { queued, failed, finishesAt: last };
}

/**
 * Trava do worker, logo antes de mandar: o paciente agendou ou voltou depois do clique? (Kadu 12/11: nunca
 * mandar "retomar contato" para quem já agendou.) Confere sessão/pacote depois da avaliação e sessão futura.
 * @returns {Promise<boolean>}
 */
export async function hasContinuedSince(evaluationIds = []) {
    if (!evaluationIds.length) return false;
    const docs = await EvaluationReengagement.find({ evaluation: { $in: evaluationIds } }).select('patient evaluatedAt').lean();
    if (!docs.length) return false;
    const todayStart = moment().tz(TIMEZONE).startOf('day').toDate();
    for (const d of docs) {
        const since = d.evaluatedAt || new Date(0);
        const [appt, pkg] = await Promise.all([
            Appointment.exists({
                patient: d.patient,
                isDeleted: { $ne: true },
                $or: [
                    { date: { $gt: since }, operationalStatus: { $in: CONTINUITY_STATUSES } },
                    { date: { $gte: todayStart }, operationalStatus: { $in: FUTURE_STATUSES } },
                ],
            }),
            Package.exists({ patient: d.patient, status: { $ne: 'canceled' }, createdAt: { $gte: new Date(new Date(since).getTime() - DAY_MS) } }),
        ]);
        if (appt || pkg) return true;
    }
    return false;
}

/** Worker: mensagem saiu. */
export async function markReengageSent(evaluationIds = [], { messageId = null, at = new Date() } = {}) {
    if (!evaluationIds.length) return;
    await EvaluationReengagement.updateMany({ evaluation: { $in: evaluationIds } }, { $set: { sentAt: at, messageId, error: null } });
}

/** Worker: não enviado de propósito (conversa recente). Não conta no teto do dia (busySlots ignora skippedAt). */
export async function markReengageSkipped(evaluationIds = [], { reason = '', lastClinicAt = null, at = new Date() } = {}) {
    if (!evaluationIds.length) return;
    await EvaluationReengagement.updateMany(
        { evaluation: { $in: evaluationIds } },
        {
            $set: { skippedAt: at, skipReason: String(reason).slice(0, 200) },
            ...(lastClinicAt ? { $max: { lastClinicMessageAt: lastClinicAt } } : {}),
        },
    );
}

/** Worker: falha definitiva (sem WhatsApp, número inválido). */
export async function markReengageFailed(evaluationIds = [], error = '') {
    if (!evaluationIds.length) return;
    await EvaluationReengagement.updateMany({ evaluation: { $in: evaluationIds } }, { $set: { error: String(error).slice(0, 200) } });
}
