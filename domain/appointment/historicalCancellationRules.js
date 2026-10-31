const CANCELED = new Set(['canceled', 'cancelled', 'force_cancelled']);
export function cancellationError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode, code: 'LIMINAR_HISTORICAL_CANCELLATION' });
}
export function normalizeCancellations(input) {
  if (!Array.isArray(input) || !input.length || input.length > 50) throw cancellationError('Informe entre 1 e 50 cancelamentos.');
  const seen = new Set();
  return input.map((r, index) => {
    const fail = message => { throw cancellationError(`Linha ${index + 1}: ${message}`); };
    if (!r || typeof r !== 'object') fail('registro inválido.');
    if (typeof r.specialty !== 'string' || !r.specialty) fail('informe a especialidade.');
    const parsedDate = new Date(`${r.date}T12:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date || '') || Number.isNaN(+parsedDate) || parsedDate.toISOString().slice(0, 10) !== r.date) fail('data inválida.');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time || '')) fail('horário inválido.');
    if (!/^[a-f\d]{24}$/i.test(r.doctorId || '')) fail('informe o profissional.');
    if (typeof r.sessionValue !== 'number' || !Number.isFinite(r.sessionValue) || r.sessionValue < 0) fail('confirme o valor da sessão.');
    if (typeof r.reason !== 'string' || !r.reason.trim() || r.reason.length > 2000) fail('informe o motivo (até 2.000 caracteres).');
    if (!['patient', 'professional', 'clinic'].includes(r.cancelRequester)) fail('informe quem solicitou.');
    let requestedAt = null;
    if (r.cancelRequestedAt) {
      requestedAt = new Date(r.cancelRequestedAt);
      if (Number.isNaN(+requestedAt) || +requestedAt > Date.now()) fail('data do pedido inválida ou futura.');
    }
    const key = `${r.specialty}|${r.date}|${r.time}`;
    if (seen.has(key)) fail('cancelamento repetido no lote.');
    seen.add(key);
    return { specialty: r.specialty, date: r.date, time: r.time, doctorId: r.doctorId, sessionValue: r.sessionValue,
      reason: r.reason.trim(), cancelRequester: r.cancelRequester, cancelRequestedAt: requestedAt };
  });
}
export function classifyExistingCancellation(row, documents, scopeId, scopeField = 'liminarContract', { allowPending = false } = {}) {
  if (!documents.length) return { action: 'create' };
  if (documents.length === 1) {
    const doc = documents[0];
    const sameScope = String(doc[scopeField]) === String(scopeId)
      && doc.specialty === row.specialty && String(doc.doctor) === row.doctorId;
    if (sameScope) {
      if (CANCELED.has(doc.operationalStatus)) return { action: 'preserve', appointmentId: String(doc._id) };
      if (doc.operationalStatus === 'completed' || doc.clinicalStatus === 'completed') {
        return { action: 'conflict', code: 'COMPLETED_CANCELLATION_BLOCKED', appointmentId: String(doc._id),
          message: 'Não é possível cancelar este atendimento: a sessão já foi concluída ou consumida. Solicite a correção administrativa antes de registrar o cancelamento.' };
      }
      if (allowPending && ['scheduled', 'pre_agendado', 'confirmed', 'pending'].includes(doc.operationalStatus)) {
        return { action: 'cancel', appointmentId: String(doc._id), message: 'O atendimento pendente existente será cancelado, preservando seus vínculos.' };
      }
    }
  }
  return { action: 'conflict', message: 'Já existe atendimento nesse horário. Nenhum status ou vínculo será alterado automaticamente.' };
}

export const isManualHistoricalCancellation = appointment => ['canceled', 'cancelled', 'force_cancelled'].includes(appointment.operationalStatus) && appointment.history?.some(entry => entry.details?.historicalCancellation === true);
export const historicalCancellationDate = appointment => appointment.history?.find(entry => entry.details?.historicalCancellation === true)?.details?.attendanceDate || new Date(appointment.date).toISOString().slice(0, 10);
