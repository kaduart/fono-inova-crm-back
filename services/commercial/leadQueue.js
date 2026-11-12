// services/commercial/leadQueue.js
// Fila de leads da secretária (aba Leads → Fila de trabalho e card "Leads para retornar").
// 12/11/2026 (Kadu): quem já agendou tem de sair da fila, para ninguém mandar mensagem
// comercial para quem já marcou. Ver docs/COMMERCIAL_QUEUES.md, seção "Fila de leads".
//
// Somente leitura. Duas camadas:
//  1) filtro no banco (OPERATIONAL_QUEUE_FILTER): funil "agendado/virou paciente/não fechou",
//     status 'agendado' (agendamento direto) ou lead vinculado a paciente;
//  2) rede de segurança pelo telefone: lead cujo paciente (mesmo telefone) tem sessão futura
//     ou um agendamento criado depois que o lead entrou. Pega o lead antigo (WhatsApp, site)
//     que agendou por outro caminho e ficou com o funil parado.

import Appointment from '../../models/Appointment.js';
import Patient from '../../models/Patient.js';
import { FUTURE_STATUSES, phoneTail } from './commercialRules.js';

const NOT_COUNT_STATUSES = ['canceled', 'force_cancelled', 'suspended'];

/**
 * @param {Array<{ _id: any, createdAt?: Date, contact?: { phone?: string }, operational?: { phone?: string } }>} leads
 * @param {Date} now
 * @returns {Promise<Set<string>>} ids dos leads que já têm agendamento
 */
export async function leadIdsWithAppointment(leads = [], now = new Date()) {
  const out = new Set();
  const byTail = new Map(); // 8 últimos dígitos → leads
  for (const l of leads) {
    const tail = phoneTail(l?.contact?.phone || l?.operational?.phone);
    if (!tail) continue;
    if (!byTail.has(tail)) byTail.set(tail, []);
    byTail.get(tail).push(l);
  }
  if (!byTail.size) return out;

  // Telefone do paciente pode ter máscara: pré-filtra pelos 4 últimos dígitos e confirma em memória.
  const last4 = [...new Set([...byTail.keys()].map((t) => t.slice(-4)))];
  const patients = (await Patient.find(
    { phone: { $regex: `(${last4.join('|')})\\D*$` } },
    { phone: 1 },
  ).lean()).filter((p) => byTail.has(phoneTail(p.phone)));
  if (!patients.length) return out;

  const appts = await Appointment.aggregate([
    { $match: { patient: { $in: patients.map((p) => p._id) }, isDeleted: { $ne: true }, operationalStatus: { $nin: NOT_COUNT_STATUSES } } },
    {
      $group: {
        _id: '$patient',
        lastCreatedAt: { $max: '$createdAt' },
        hasFuture: { $max: { $and: [{ $gte: ['$date', now] }, { $in: ['$operationalStatus', FUTURE_STATUSES] }] } },
      },
    },
  ]);
  const byPatient = new Map(appts.map((a) => [String(a._id), a]));

  for (const p of patients) {
    const a = byPatient.get(String(p._id));
    if (!a) continue;
    for (const l of byTail.get(phoneTail(p.phone)) || []) {
      const createdAfterLead = a.lastCreatedAt && l.createdAt && new Date(a.lastCreatedAt) >= new Date(l.createdAt);
      if (a.hasFuture || createdAfterLead) out.add(String(l._id));
    }
  }
  return out;
}

/** Remove da lista os leads que já têm agendamento (camada 2). */
export async function withoutScheduledLeads(leads = [], now = new Date()) {
  if (!leads.length) return leads;
  const scheduled = await leadIdsWithAppointment(leads, now);
  return scheduled.size ? leads.filter((l) => !scheduled.has(String(l._id))) : leads;
}
