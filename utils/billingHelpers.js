// utils/billingHelpers.js
import Session from '../models/Session.js';

/**
 * 🛠️ Billing Helpers
 *
 * Funções utilitárias compartilhadas entre services de faturamento.
 * Extrai lógica comum para evitar duplicação.
 */

/**
 * Sanitiza valores de ID
 * Remove booleanos, strings "false"/"true", valores vazios
 *
 * @param {any} value - Valor a sanitizar
 * @returns {string|null} ID limpo ou null
 *
 * @example
 * safeId(false) // null
 * safeId("false") // null
 * safeId("") // null
 * safeId("507f1f77bcf86cd799439011") // "507f1f77bcf86cd799439011"
 */
export function safeId(value) {
  if (value === false || value === true) return null;
  if (value === "false" || value === "true") return null;
  if (value === "" || value === undefined || value === null) return null;
  return value;
}

/**
 * Valida formato de data e hora
 *
 * @param {string} date - Data no formato YYYY-MM-DD
 * @param {string} time - Hora no formato HH:mm
 * @throws {Error} Se formato inválido
 *
 * @example
 * validateDateTime('2025-02-20', '14:00') // OK
 * validateDateTime('2025/02/20', '14:00') // Lança erro
 * validateDateTime('2025-02-20', '14') // Lança erro
 */
export function validateDateTime(date, time) {
  // Validar formato de data YYYY-MM-DD
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(date)) {
    throw new Error(`Data inválida: esperado YYYY-MM-DD, recebido "${date}"`);
  }

  // Validar formato de hora HH:mm
  const timeRegex = /^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/;
  if (!timeRegex.test(time)) {
    throw new Error(`Hora inválida: esperado HH:mm, recebido "${time}"`);
  }

  // Validar se data é válida (não aceita 2025-02-30, por exemplo)
  const parsedDate = new Date(date);
  if (isNaN(parsedDate.getTime())) {
    throw new Error(`Data inválida: "${date}" não é uma data válida`);
  }
}

/**
 * Verifica conflito de horário na agenda
 * Busca sessões conflitantes para o mesmo doctor, patient, data e hora
 *
 * @param {Object} params - Parâmetros da busca
 * @param {string} params.date - Data (YYYY-MM-DD)
 * @param {string} params.time - Hora (HH:mm)
 * @param {ObjectId|string} params.doctorId - ID do profissional
 * @param {ObjectId|string} params.patientId - ID do paciente
 * @param {string} params.specialty - Especialidade
 * @param {ObjectId|string} [params.excludeId] - ID da sessão a ignorar (para edição)
 * @param {ClientSession} params.session - Sessão MongoDB para transação
 * @returns {Promise<Session|null>} Sessão conflitante ou null
 *
 * @example
 * const conflict = await checkScheduleConflict({
 *   date: '2025-02-20',
 *   time: '14:00',
 *   doctorId: '507f1f77bcf86cd799439011',
 *   patientId: '507f191e810c19729de860ea',
 *   specialty: 'fonoaudiologia',
 *   session: mongoSession
 * });
 *
 * if (conflict) {
 *   throw new Error('Horário já ocupado');
 * }
 */
/**
 * Determina se uma sessão é de convênio de forma robusta.
 * Centraliza a lógica de elegibilidade para evitar divergências entre endpoints.
 *
 * @param {Object} session - Objeto Session (pode ser lean ou documento)
 * @returns {boolean} true se a sessão é de convênio
 */
export function isConvenioSession(session) {
  if (!session) return false;
  return (
    session.billingType === 'convenio' ||
    session.paymentMethod === 'convenio' ||
    !!session.insuranceGuide ||
    session.package?.type === 'convenio' ||
    session.packageType === 'convenio'
  );
}

/**
 * Determina o billingType canônico de uma sessão.
 * Fallback para 'particular' quando nenhum sinal forte é encontrado.
 *
 * @param {Object} session - Objeto Session
 * @returns {'particular' | 'convenio' | 'liminar'} billingType derivado
 */
export function resolveSessionBillingType(session) {
  if (!session) return 'particular';
  if (isConvenioSession(session)) return 'convenio';
  if (
    session.billingType === 'liminar' ||
    session.paymentMethod === 'liminar_credit' ||
    session.paymentOrigin === 'liminar'
  ) return 'liminar';
  return 'particular';
}

export async function checkScheduleConflict({
  date,
  time,
  doctorId,
  patientId,
  specialty,
  excludeId = null,
  session
}) {
  const query = {
    date,
    time,
    doctor: doctorId,
    patient: patientId,
    specialty,
    status: { $nin: ['canceled', 'missed'] }
  };

  // Ignorar sessão atual em caso de edição
  if (excludeId) {
    query._id = { $ne: excludeId };
  }

  const conflict = await Session.findOne(query).session(session);

  return conflict;
}
