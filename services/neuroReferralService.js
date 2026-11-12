// services/neuroReferralService.js
// Candidatos a neuro: sugestão automática, reconciliação com a agenda e regras de transição.
import mongoose from 'mongoose';
import {
    NEURO_REFERRAL_ACTIVE_STATUS,
    NEURO_REFERRAL_DECLINE_COOLDOWN_DAYS,
    NEURO_REFERRAL_HOME_SPECIALTIES,
    NEURO_REFERRAL_TRANSITIONS,
    NEURO_SIGNAL_PATTERNS,
    NEURO_SPECIALTY,
} from '../constants/neuroReferral.js';
import NeuroReferral from '../models/NeuroReferral.js';

const LOG = '[NEURO-REFERRAL]';

// Agendamentos que não contam (nem como "é paciente da casa", nem como "já marcou neuro").
const DEAD_APPOINTMENT_STATUS = ['canceled', 'force_cancelled', 'processing_cancel'];

const model = (name) => mongoose.models[name] || null;

export const normalizeText = (text) => String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/**
 * Procura sinais de TEA/TDAH em textos livres.
 * @param {Array<{where:string,text:string}>} sources
 * @returns {{reasons:string[], terms:string[], matchedIn:string[]}}
 */
export const detectNeuroSignals = (sources = []) => {
    const reasons = new Set();
    const terms = new Set();
    const matchedIn = new Set();
    for (const { where, text } of sources) {
        const norm = normalizeText(text);
        if (!norm.trim()) continue;
        for (const p of NEURO_SIGNAL_PATTERNS) {
            if (p.re.test(norm)) {
                reasons.add(p.reason);
                terms.add(p.term);
                matchedIn.add(where);
            }
        }
    }
    return { reasons: [...reasons], terms: [...terms], matchedIn: [...matchedIn] };
};

// Anamnese nova guarda o formulário em `content` (Mixed). Só lemos campos de queixa/hipótese,
// para não pegar perguntas do tipo "tem diagnóstico de TEA? não".
const ANAMNESIS_KEY_RE = /queixa|complaint|hipotes|hypothes/i;
export const extractAnamnesisTexts = (doc) => {
    const out = [];
    if (doc?.identification?.mainComplaint) out.push(doc.identification.mainComplaint);
    if (doc?.conclusions?.diagnosticHypotheses) out.push(doc.conclusions.diagnosticHypotheses);
    const walk = (node, depth = 0) => {
        if (!node || typeof node !== 'object' || depth > 4) return;
        for (const [key, value] of Object.entries(node)) {
            if (typeof value === 'string' && ANAMNESIS_KEY_RE.test(key)) out.push(value);
            else if (value && typeof value === 'object') walk(value, depth + 1);
        }
    };
    walk(doc?.content);
    return out;
};

/** Pode `role` levar a indicação de `from` para `to`? */
export const canTransition = (role, from, to) => {
    if (from === to) return false;
    if (role === 'admin') return true;
    return (NEURO_REFERRAL_TRANSITIONS[role]?.[from] || []).includes(to);
};

/** Campos derivados de um novo status (activeKey, datas). Não salva. */
export const applyStatus = (referral, status, actor = {}, note = null, extra = {}) => {
    const now = new Date();
    referral.status = status;
    referral.activeKey = NEURO_REFERRAL_ACTIVE_STATUS.includes(status) ? String(referral.patient) : undefined;
    if (status === 'oferecido' && !referral.offeredAt) referral.offeredAt = now;
    if (status === 'agendado') referral.scheduledAt = referral.scheduledAt || now;
    referral.closedAt = NEURO_REFERRAL_ACTIVE_STATUS.includes(status) ? null : now;
    if (status === 'recusado' && extra.declineReason !== undefined) referral.declineReason = extra.declineReason;
    if (extra.appointment) referral.appointment = extra.appointment;
    referral.history.push({ status, at: now, by: { id: actor.id || null, role: actor.role || null }, note });
    return referral;
};

/**
 * Marca como "agendado" as indicações ativas cujo paciente já tem consulta de neuro marcada
 * depois da indicação. Idempotente: roda a cada leitura da lista.
 */
export const reconcileScheduled = async () => {
    const Appointment = model('Appointment');
    if (!Appointment) return 0;
    const active = await NeuroReferral.find({ status: { $in: NEURO_REFERRAL_ACTIVE_STATUS } })
        .select('_id patient createdAt').lean();
    if (!active.length) return 0;

    const appts = await Appointment.find({
        patient: { $in: active.map(r => r.patient) },
        specialty: NEURO_SPECIALTY,
        operationalStatus: { $nin: DEAD_APPOINTMENT_STATUS },
    }).select('_id patient createdAt').sort({ createdAt: 1 }).lean();

    let updated = 0;
    for (const ref of active) {
        const appt = appts.find(a => String(a.patient) === String(ref.patient));
        if (!appt) continue;
        const doc = await NeuroReferral.findOne({ _id: ref._id, status: { $in: NEURO_REFERRAL_ACTIVE_STATUS } });
        if (!doc) continue;
        applyStatus(doc, 'agendado', { role: 'system' }, 'Consulta de neuro encontrada na agenda', { appointment: appt._id });
        await doc.save();
        updated += 1;
    }
    if (updated) console.log(`${LOG} ${updated} indicação(ões) marcadas como agendadas pela agenda`);
    return updated;
};

/**
 * Sugestão automática: pacientes ativos de fono/psico/TO, sem consulta de neuro, com sinal de TEA/TDAH
 * na queixa (paciente/agendamento) ou na anamnese. Cria em "a_confirmar" para a terapeuta confirmar.
 * Idempotente (índice único de indicação ativa por paciente).
 * @param {{dryRun?:boolean, actor?:{id?:string,role?:string}}} opts
 */
export const scanSuggestions = async ({ dryRun = false, actor = {} } = {}) => {
    const Appointment = model('Appointment');
    const Patient = model('Patient');
    const Anamnesis = model('AnamnesisReport');
    if (!Appointment || !Patient) throw new Error('Models Appointment/Patient não registrados');

    // 1) Pacientes da casa (com atendimento em fono/psico/TO) e suas queixas no agendamento
    const home = await Appointment.aggregate([
        { $match: { specialty: { $in: NEURO_REFERRAL_HOME_SPECIALTIES }, operationalStatus: { $nin: DEAD_APPOINTMENT_STATUS }, patient: { $ne: null } } },
        { $group: { _id: '$patient', specialties: { $addToSet: '$specialty' }, complaints: { $addToSet: '$mainComplaint' } } },
    ]);
    if (!home.length) return { scanned: 0, candidates: 0, created: 0, items: [] };
    const homeIds = home.map(h => h._id);

    // 2) Exclusões: já marcou neuro, paciente inativo, indicação existente que bloqueia
    const [neuroPatients, patients, referrals] = await Promise.all([
        Appointment.distinct('patient', { patient: { $in: homeIds }, specialty: NEURO_SPECIALTY, operationalStatus: { $nin: DEAD_APPOINTMENT_STATUS } }),
        Patient.find({ _id: { $in: homeIds }, status: { $ne: 'inactive' }, isLead: { $ne: true } }).select('_id fullName mainComplaint').lean(),
        NeuroReferral.find({ patient: { $in: homeIds } }).select('patient status closedAt updatedAt').lean(),
    ]);
    const neuroSet = new Set(neuroPatients.map(String));
    const cooldownMs = NEURO_REFERRAL_DECLINE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
    const blocked = new Set(referrals.filter(r => (
        r.status !== 'recusado' || (Date.now() - new Date(r.closedAt || r.updatedAt).getTime()) < cooldownMs
    )).map(r => String(r.patient)));
    const eligible = patients.filter(p => !neuroSet.has(String(p._id)) && !blocked.has(String(p._id)));
    if (!eligible.length) return { scanned: home.length, candidates: 0, created: 0, items: [] };

    // 3) Anamneses dos elegíveis
    const anamneses = Anamnesis
        ? await Anamnesis.find({ patientId: { $in: eligible.map(p => p._id) } })
            .select('patientId identification.mainComplaint conclusions.diagnosticHypotheses content').lean()
        : [];

    const homeById = new Map(home.map(h => [String(h._id), h]));
    const items = [];
    for (const p of eligible) {
        const h = homeById.get(String(p._id));
        const sources = [
            { where: 'queixa_paciente', text: p.mainComplaint },
            ...(h.complaints || []).map(text => ({ where: 'queixa_agendamento', text })),
            ...anamneses.filter(a => String(a.patientId) === String(p._id))
                .flatMap(a => extractAnamnesisTexts(a).map(text => ({ where: 'anamnese', text }))),
        ];
        const signals = detectNeuroSignals(sources);
        if (!signals.reasons.length) continue;
        items.push({ patient: p._id, fullName: p.fullName, homeSpecialties: h.specialties, ...signals });
    }

    if (dryRun) {
        console.log(`${LOG} simulação: ${items.length} candidato(s) de ${home.length} paciente(s) da casa`);
        return { scanned: home.length, candidates: items.length, created: 0, items };
    }

    let created = 0;
    for (const item of items) {
        const doc = new NeuroReferral({
            patient: item.patient,
            source: 'sugestao_automatica',
            reasons: item.reasons,
            matchedTerms: item.terms,
            matchedIn: item.matchedIn,
            homeSpecialties: item.homeSpecialties,
            requestedBy: { id: actor.id || null, role: actor.role || 'system' },
            history: [],
        });
        applyStatus(doc, 'a_confirmar', { id: actor.id, role: actor.role || 'system' }, `Sinais: ${item.terms.join(', ')}`);
        try {
            await doc.save();
            created += 1;
        } catch (err) {
            if (err?.code !== 11000) throw err; // corrida com outra varredura/indicação: já existe ativo
        }
    }
    console.log(`${LOG} varredura: ${created} sugestão(ões) criadas, ${items.length} candidato(s), ${home.length} paciente(s) da casa`);
    return { scanned: home.length, candidates: items.length, created, items: items.map(({ patient, fullName, reasons }) => ({ patient, fullName, reasons })) };
};

/** Ids de pacientes atendidos por um profissional (para a terapeuta ver só os seus). */
export const patientIdsOfDoctor = async (doctorId) => {
    const Appointment = model('Appointment');
    if (!Appointment || !mongoose.Types.ObjectId.isValid(doctorId)) return [];
    return Appointment.distinct('patient', {
        doctor: new mongoose.Types.ObjectId(String(doctorId)),
        operationalStatus: { $nin: DEAD_APPOINTMENT_STATUS },
    });
};
