/**
 * 🎂 Mensagem de aniversário (WhatsApp)
 *
 * Único caminho de envio do "feliz aniversário" — usado pelo cron diário das 10h
 * (crons/birthdayMessage.cron.js) e pelo botão do dashboard (POST /patients/:id/birthday-message).
 *
 * Garantias:
 * - Só envia NO DIA do aniversário (fuso America/Sao_Paulo).
 * - No máximo 1 mensagem por paciente por ano: o "já enviei" é gravado de forma atômica no
 *   Patient (birthdayMessageSentYear) ANTES de enfileirar, e o jobId da fila é determinístico.
 *   Cron + clique manual + reexecução do cron não duplicam.
 * - Se enfileirar falhar, a trava é desfeita (pode tentar de novo).
 * - Envio pela fila `whatsapp-send` (WhatsApp Web da clínica), a mesma da agenda.
 *
 * dateOfBirth não tem semântica de horário: é gravado como meia-noite UTC do dia pretendido.
 * Por isso dia/mês do nascimento são lidos em UTC (nunca com getters locais).
 */

import moment from 'moment-timezone';
import Patient from '../../models/Patient.js';
import { whatsappSendQueue } from '../../config/bullConfig.js';
import { sanitizePhoneBeforeSend } from '../../utils/phone.js';

export const BIRTHDAY_TIMEZONE = 'America/Sao_Paulo';

// Cadastros antigos não têm o campo `status` (o default 'active' só vale para documentos novos):
// ausência de status = paciente ativo. Só 'inactive' e 'lead' ficam de fora.
const isActivePatient = (p) => !p.status || p.status === 'active';

export function buildBirthdayMessage(fullName) {
  const first = String(fullName || '').trim().split(/\s+/)[0] || '';
  const quem = first ? `o aniversário de *${first}*` : 'um aniversário muito especial';

  return [
    'Olá! 💚',
    '',
    `Hoje é um dia especial: ${quem}! 🎉🎂`,
    '',
    'Toda a equipe da *Clínica Fono Inova* deseja muitas felicidades, saúde e conquistas.',
    '',
    'É um prazer fazer parte desse desenvolvimento. 🤗',
  ].join('\n');
}

const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/**
 * `now` é um moment já no fuso da clínica. Quem nasceu em 29/02 é parabenizado em 28/02
 * nos anos não bissextos.
 */
export function isBirthdayToday(dateOfBirth, now = moment().tz(BIRTHDAY_TIMEZONE)) {
  if (!dateOfBirth) return false;
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return false;

  const dobDay = dob.getUTCDate();
  const dobMonth = dob.getUTCMonth() + 1;
  const day = now.date();
  const month = now.month() + 1;

  if (dobDay === day && dobMonth === month) return true;
  return dobDay === 29 && dobMonth === 2 && day === 28 && month === 2 && !isLeapYear(now.year());
}

/**
 * Pacientes ATIVOS, com telefone, que fazem aniversário hoje e ainda não receberam neste ano.
 */
export async function findBirthdayPatientsToSend(now = moment().tz(BIRTHDAY_TIMEZONE)) {
  const year = now.year();
  const candidates = await Patient.find({
    status: { $in: ['active', null] }, // null casa também com cadastro antigo sem o campo
    dateOfBirth: { $ne: null },
    phone: { $exists: true, $ne: '' },
    birthdayMessageSentYear: { $ne: year },
  })
    .select('fullName dateOfBirth phone')
    .lean();

  return candidates.filter((p) => isBirthdayToday(p.dateOfBirth, now));
}

/**
 * Resumo do dia calculado no backend (o front só exibe).
 * - todayTotal: quantos pacientes da lista fazem aniversário hoje.
 * - todayPending: quantos ainda faltam receber — ativos, com telefone válido e sem envio neste ano
 *   (mesmos critérios do cron). Cada envio (manual ou automático) reduz esse número; chegando
 *   a 0 o aviso "temos aniversariantes hoje" some.
 * Marca também, em cada paciente, se já recebeu o parabéns neste ano (birthdayMessageSent).
 */
export function summarizeBirthdays(patients, now = moment().tz(BIRTHDAY_TIMEZONE)) {
  const year = now.year();
  let todayTotal = 0;
  let todayPending = 0;

  const list = patients.map((p) => {
    const birthdayMessageSent = p.birthdayMessageSentYear === year;
    if (isBirthdayToday(p.dateOfBirth, now)) {
      todayTotal++;
      const sendable = isActivePatient(p) && sanitizePhoneBeforeSend(p.phone).success;
      if (sendable && !birthdayMessageSent) todayPending++;
    }
    return { ...p, birthdayMessageSent };
  });

  return { list, meta: { todayTotal, todayPending } };
}

/**
 * Envia (enfileira) o parabéns de um paciente.
 * @returns {{sent: boolean, reason?: string, jobId?: string}}
 */
export async function sendBirthdayMessage(patientId, { delayMs = 0, now = moment().tz(BIRTHDAY_TIMEZONE) } = {}) {
  const year = now.year();

  const patient = await Patient.findById(patientId)
    .select('fullName dateOfBirth phone birthdayMessageSentYear')
    .lean();
  if (!patient) return { sent: false, reason: 'not_found' };
  if (!isBirthdayToday(patient.dateOfBirth, now)) return { sent: false, reason: 'not_birthday_today' };
  if (patient.birthdayMessageSentYear === year) return { sent: false, reason: 'already_sent' };

  const phone = sanitizePhoneBeforeSend(patient.phone);
  if (!phone.success) return { sent: false, reason: 'invalid_phone' };

  // Trava atômica: só quem conseguir virar o ano de "não enviado" para "enviado" segue.
  const claimed = await Patient.updateOne(
    { _id: patientId, birthdayMessageSentYear: { $ne: year } },
    { $set: { birthdayMessageSentYear: year, birthdayMessageSentAt: new Date() } }
  );
  if (!claimed.modifiedCount) return { sent: false, reason: 'already_sent' };

  try {
    const job = await whatsappSendQueue.add(
      'send-message',
      { phone: phone.phone, message: buildBirthdayMessage(patient.fullName) },
      // jobId sem ':' (o BullMQ não aceita) — segunda camada contra duplicidade.
      { jobId: `birthday-${patientId}-${year}`, ...(delayMs > 0 && { delay: delayMs }) }
    );
    return { sent: true, jobId: job.id };
  } catch (err) {
    // Não enfileirou: devolve a trava para poder tentar de novo.
    await Patient.updateOne(
      { _id: patientId, birthdayMessageSentYear: year },
      { $set: { birthdayMessageSentYear: patient.birthdayMessageSentYear ?? null, birthdayMessageSentAt: null } }
    );
    throw err;
  }
}
