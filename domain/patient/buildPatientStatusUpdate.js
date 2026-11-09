import { AppError } from '../../errors/AppError.js';
import { PATIENT_INACTIVATION_REASONS, isValidInactivationReason } from './inactivationReasons.js';

/**
 * Monta o $set para inativar ou reativar um paciente (Kadu, 09/11/2026).
 * Função pura: não lê nem grava no banco.
 *
 * - Inativar exige um motivo da lista fixa; a observação é opcional.
 * - Reativar mantém o motivo e a data da inativação (histórico para campanhas)
 *   e só acrescenta quando e quem reativou.
 * - Não cancela agendamentos: a recepção decide pela agenda.
 */
export function buildPatientStatusUpdate({ status, reason, note, user, now = new Date(), current = {} }) {
  if (!['active', 'inactive'].includes(status)) {
    throw new AppError('PATIENT_STATUS_INVALID', 'Status inválido.', {
      status: 400,
      title: 'Status inválido',
      action: 'Use "Inativar" ou "Reativar".',
    });
  }

  const byId = user?.id || user?._id || null;
  const byName = user?.name || user?.fullName || user?.email || null;

  if (status === 'inactive') {
    if (!isValidInactivationReason(reason)) {
      throw new AppError('PATIENT_INACTIVATION_REASON_REQUIRED', 'Escolha o motivo da inativação.', {
        status: 400,
        title: 'Falta o motivo',
        action: 'Escolha um dos motivos da lista. Ele vai ser usado nas campanhas de retorno.',
        details: { allowed: Object.keys(PATIENT_INACTIVATION_REASONS) },
      });
    }
    const cleanNote = typeof note === 'string' ? note.trim().slice(0, 500) : '';
    return {
      status: 'inactive',
      'inactivation.reason': reason,
      'inactivation.note': cleanNote || null,
      'inactivation.at': now,
      'inactivation.by': byId,
      'inactivation.byName': byName,
      'inactivation.reactivatedAt': null,
      'inactivation.reactivatedBy': null,
      updatedBy: byId,
      updatedAt: now,
    };
  }

  // Reativar
  const set = { status: 'active', updatedBy: byId, updatedAt: now };
  if (current?.status === 'inactive') {
    set['inactivation.reactivatedAt'] = now;
    set['inactivation.reactivatedBy'] = byId;
  }
  return set;
}
