// services/convenioWaitlistWhatsapp.js
// Leva para a lista de interesse em convênios (convenio_waitlist) quem falou do convênio no WhatsApp Web.
// Duas entradas: varredura do histórico (fila whatsapp-scan) e captura ao vivo de mensagem recebida.
// Só escreve em convenio_waitlist; nunca envia mensagem. Ver docs/flows/convenio_interest_whatsapp.md.
import ConvenioWaitlist from '../models/ConvenioWaitlist.js';
import Patient from '../models/Patient.js';
import Appointment from '../models/Appointment.js';
import {
    CONVENIO_LABELS,
    WAITLIST_ACTIVE_STATUS,
    waitlistActiveKey,
} from '../constants/convenioWaitlist.js';
import { normalizeE164BR, digitsOnly } from '../utils/phone.js';

const TAG = '[ConvenioInteresseWA]';
const SNIPPET_MAX = 280;
import { FUTURE_STATUSES } from './commercial/commercialRules.js';

export const isRealBRPhone = (p) => /^55\d{10,11}$/.test(String(p || ''));

/** Variantes com e sem o 9 após o DDD (WhatsApp às vezes entrega o formato antigo). */
export function phoneVariants(normalized) {
    const variants = [normalized];
    const m = String(normalized || '').match(/^55(\d{2})(9?)(\d{8})$/);
    if (m) variants.push(m[2] ? `55${m[1]}${m[3]}` : `55${m[1]}9${m[3]}`);
    return variants;
}

/** Celular no formato antigo (sem o 9 após o DDD) vira o formato atual, para o mesmo contato não duplicar. */
export function canonicalPhone(phone) {
    const normalized = normalizeE164BR(phone);
    if (!normalized) return null;
    const m = normalized.match(/^55(\d{2})([6-9]\d{7})$/);
    return m ? `55${m[1]}9${m[2]}` : normalized;
}

const cleanSnippet = (text) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX) || null;

/**
 * Registra (idempotente) o interesse de um contato do WhatsApp num convênio.
 * - Já existe cadastro ATIVO (aguardando/contatado) do telefone nesse convênio → só completa os dados do WhatsApp.
 * - Já existe cadastro encerrado (agendado/descartado) → não recria (a equipe já tratou).
 * - Não existe → cria com status 'aguardando' e channel 'whatsapp_web'.
 *
 * @param {{ phone: string, convenio: string, name?: string|null, firstAt?: Date, lastAt?: Date,
 *           snippet?: string|null, snippetFromContact?: boolean, mentionedBy?: string[], capturedBy?: 'scan'|'live' }} input
 * @returns {Promise<{ result: 'created'|'updated'|'closed'|'invalid', id?: string }>}
 */
export async function recordWhatsappInterest(input) {
    const normalized = canonicalPhone(input?.phone);
    if (!normalized || !isRealBRPhone(normalized) || !CONVENIO_LABELS[input?.convenio]) return { result: 'invalid' };

    const { convenio } = input;
    const firstAt = input.firstAt instanceof Date ? input.firstAt : new Date();
    const lastAt = input.lastAt instanceof Date ? input.lastAt : firstAt;
    const snippet = cleanSnippet(input.snippet);
    const snippetFromContact = Boolean(input.snippetFromContact);
    const mentionedBy = (input.mentionedBy || []).filter((v) => v === 'contato' || v === 'clinica');
    const capturedBy = input.capturedBy === 'live' ? 'live' : 'scan';

    const existing = await ConvenioWaitlist.find({ phone: { $in: phoneVariants(normalized) }, convenio })
        .select('_id status whatsapp')
        .lean();
    const active = existing.find((d) => WAITLIST_ACTIVE_STATUS.includes(d.status));

    if (active) {
        const set = {};
        // Trecho: o do contato vale mais que o da clínica; entre dois do contato, o mais recente.
        if (snippet && (snippetFromContact || !active.whatsapp?.snippetFromContact)) {
            set['whatsapp.snippet'] = snippet;
            set['whatsapp.snippetFromContact'] = snippetFromContact;
        }
        if (!active.whatsapp?.capturedBy) set['whatsapp.capturedBy'] = capturedBy;
        // $min/$max não servem: no Mongo null é "menor" que data, e cadastro do site começa com null.
        const prevFirst = active.whatsapp?.firstMentionAt ? new Date(active.whatsapp.firstMentionAt) : null;
        const prevLast = active.whatsapp?.lastMentionAt ? new Date(active.whatsapp.lastMentionAt) : null;
        if (!prevFirst || firstAt < prevFirst) set['whatsapp.firstMentionAt'] = firstAt;
        if (!prevLast || lastAt > prevLast) set['whatsapp.lastMentionAt'] = lastAt;
        await ConvenioWaitlist.updateOne(
            { _id: active._id },
            {
                ...(Object.keys(set).length ? { $set: set } : {}),
                ...(mentionedBy.length ? { $addToSet: { 'whatsapp.mentionedBy': { $each: mentionedBy } } } : {}),
            },
        );
        return { result: 'updated', id: String(active._id) };
    }

    if (existing.length) return { result: 'closed', id: String(existing[0]._id) };

    const activeKey = waitlistActiveKey(normalized, convenio);
    const doc = {
        name: String(input.name || '').trim().slice(0, 120) || 'Contato do WhatsApp',
        phone: normalized,
        convenio,
        status: 'aguardando',
        activeKey,
        channel: 'whatsapp_web',
        requestCount: 1,
        whatsapp: {
            firstMentionAt: firstAt,
            lastMentionAt: lastAt,
            snippet,
            snippetFromContact,
            mentionedBy,
            capturedBy,
        },
        // Sem formulário: a pessoa procurou a clínica, mas não aceitou o termo do site.
        consent: { accepted: false, acceptedAt: null, version: null },
        createdAt: firstAt, // entra na lista na data em que procurou, não na data da varredura
    };

    try {
        const res = await ConvenioWaitlist.updateOne({ activeKey }, { $setOnInsert: doc }, { upsert: true, timestamps: false });
        if (res.upsertedCount) {
            await ConvenioWaitlist.updateOne({ _id: res.upsertedId }, { $set: { updatedAt: new Date() } }, { timestamps: false });
            console.log(`${TAG} ✅ novo interessado ${CONVENIO_LABELS[convenio]} pelo WhatsApp`, { tail: normalized.slice(-4), capturedBy });
            return { result: 'created', id: String(res.upsertedId) };
        }
        return { result: 'updated' };
    } catch (err) {
        if (err?.code === 11000) return { result: 'updated' }; // corrida: outro processo criou o mesmo ativo
        throw err;
    }
}

/**
 * Junta mensagens encontradas (varredura) por contato e convênio.
 * @param {Array<{ phone: string, convenio: string, fromMe: boolean, body: string, at: Date, name?: string|null }>} hits
 */
export function groupHitsByContact(hits = []) {
    const byKey = new Map();
    for (const h of hits) {
        const phone = canonicalPhone(h.phone);
        if (!phone || !isRealBRPhone(phone) || !h.convenio) continue;
        const key = `${phone}:${h.convenio}`;
        const at = h.at instanceof Date && !Number.isNaN(h.at.getTime()) ? h.at : new Date();
        const g = byKey.get(key) || {
            phone, convenio: h.convenio, name: null, firstAt: at, lastAt: at,
            snippet: null, snippetFromContact: false, snippetAt: null, mentionedBy: new Set(),
        };
        if (at < g.firstAt) g.firstAt = at;
        if (at > g.lastAt) g.lastAt = at;
        if (!g.name && h.name) g.name = h.name;
        g.mentionedBy.add(h.fromMe ? 'clinica' : 'contato');
        const fromContact = !h.fromMe;
        const better = !g.snippet
            || (fromContact && !g.snippetFromContact)
            || (fromContact === g.snippetFromContact && at > g.snippetAt);
        if (h.body && better) {
            g.snippet = h.body; g.snippetFromContact = fromContact; g.snippetAt = at;
        }
        byKey.set(key, g);
    }
    return [...byKey.values()].map(({ snippetAt, mentionedBy, ...g }) => ({ ...g, mentionedBy: [...mentionedBy] }));
}

/**
 * Para a tela: diz se o telefone já é paciente e se tem sessão futura (pre_agendado incluso).
 * Só leitura. 2 consultas para a página inteira.
 * @returns {Promise<Map<string, { patientId: string, patientName: string, nextAppointmentAt: Date|null }>>}
 */
export async function patientMatchesByPhone(phones = []) {
    const out = new Map();
    const tails = new Map(); // 8 últimos dígitos → telefone da lista
    for (const p of new Set(phones.filter(Boolean))) {
        const d = digitsOnly(p);
        if (d && d.length >= 8) tails.set(d.slice(-8), p);
    }
    if (!tails.size) return out;

    // Telefone do paciente pode ter máscara ("(62) 99201-3573"): pré-filtra no banco pelos 4 últimos
    // dígitos (sempre juntos) e confirma em memória pelos 8 últimos, ignorando o que não é número.
    const last4 = [...new Set([...tails.keys()].map((t) => t.slice(-4)))];
    const patients = (await Patient.find(
        { phone: { $regex: `(${last4.join('|')})\\D*$` } },
        { fullName: 1, phone: 1 },
    ).lean()).filter((pt) => tails.has(digitsOnly(pt.phone || '').slice(-8)));
    if (!patients.length) return out;

    const next = await Appointment.aggregate([
        { $match: { patient: { $in: patients.map((p) => p._id) }, date: { $gte: new Date() }, operationalStatus: { $in: FUTURE_STATUSES } } },
        { $group: { _id: '$patient', at: { $min: '$date' } } },
    ]);
    const nextByPatient = new Map(next.map((n) => [String(n._id), n.at]));

    for (const pt of patients) {
        const listPhone = tails.get(digitsOnly(pt.phone).slice(-8));
        const current = out.get(listPhone);
        const nextAt = nextByPatient.get(String(pt._id)) || null;
        if (!current || (nextAt && !current.nextAppointmentAt)) {
            out.set(listPhone, { patientId: String(pt._id), patientName: pt.fullName, nextAppointmentAt: nextAt });
        }
    }
    return out;
}

/**
 * Última conversa com cada número da lista (clínica → contato e contato → clínica).
 * Usado pelo envio em massa para NÃO repetir contato com quem a equipe acabou de falar (inclusive na mão).
 * Idempotente: só avança as datas ($max). Telefones fora da lista não gravam nada.
 *
 * @param {Array<{ phone: string, clinicAt?: Date|null, contactAt?: Date|null }>} rows
 * @returns {Promise<{ matched: number }>}
 */
export async function recordChatActivity(rows = []) {
    const ops = [];
    for (const r of rows) {
        const normalized = canonicalPhone(r?.phone);
        if (!normalized || !isRealBRPhone(normalized)) continue;
        const max = {};
        if (r.clinicAt instanceof Date && !Number.isNaN(r.clinicAt.getTime())) max['whatsapp.lastClinicMessageAt'] = r.clinicAt;
        if (r.contactAt instanceof Date && !Number.isNaN(r.contactAt.getTime())) max['whatsapp.lastContactMessageAt'] = r.contactAt;
        if (!Object.keys(max).length) continue;
        ops.push({ updateMany: { filter: { phone: { $in: phoneVariants(normalized) } }, update: { $max: max } } });
    }
    if (!ops.length) return { matched: 0 };
    const res = await ConvenioWaitlist.bulkWrite(ops, { ordered: false, timestamps: false });
    return { matched: res.matchedCount || 0 };
}

/**
 * Confere no WhatsApp Web a última mensagem da clínica com cada pessoa ATIVA da lista e grava (ver recordChatActivity).
 * Roda no crm-worker (fila whatsapp-scan, kind chat_activity). `readChatActivity` vem do whatsappWebJsService.
 */
export async function syncWaitlistChatActivity({ readChatActivity }) {
    const phones = await ConvenioWaitlist.distinct('phone', { status: { $in: WAITLIST_ACTIVE_STATUS } });
    const tails = new Set(phones.map((p) => String(p).slice(-8)));
    if (!tails.size) return { people: 0, chats: 0, withChat: 0, matched: 0 };
    const res = await readChatActivity({ onlyTails: tails });
    const { matched } = await recordChatActivity(res.rows);
    const stats = { people: phones.length, chats: res.chats, withChat: res.rows.length, unresolved: res.unresolved, matched };
    console.log(`${TAG} 🔎 última conversa conferida:`, JSON.stringify(stats));
    return stats;
}
