// back/services/appointmentStateOrchestrator.js
/**
 * Appointment State Orchestrator
 *
 * Responsabilidade: centralizar a consistência do estado de Appointment e seus derivados.
 *
 * Regras:
 * - Appointment é a fonte da verdade
 * - Session é derivada de Appointment
 * - Projeções são reativas
 * - Disponibilidade é invalidada, não computada aqui
 *
 * ATENÇÃO: este arquivo ainda não é chamado pelo fluxo legado.
 * Etapa 1 do plano de remoção do appointment.js legado.
 */

import { syncSessionFromAppointment } from './appointmentSessionSyncService.js';
import { syncAffectedViews } from './projections/syncAffectedViews.js';

const CANCELED_STATUSES = ['canceled', 'cancelado', 'cancelada', 'no_show'];

function isPrepaidPackage(pkg) {
  if (!pkg) return false;

  const paymentType = pkg.paymentType || pkg.payment_type;
  const model = pkg.model;

  return (
    paymentType !== 'per-session' &&
    paymentType !== 'per_session' &&
    model !== 'per_session'
  );
}

/**
 * Recomputa paymentStatus considerando reativação de cancelamento.
 *
 * @param {Object} appointment - Appointment com updates já aplicados
 * @param {boolean} isReactivating - se está saindo de cancelado para ativo
 * @returns {string} paymentStatus recomputado
 */
export function recomputeAppointmentPaymentStatus(appointment, isReactivating = false) {
  if (!appointment) return 'unpaid';

  // Se já tem um paymentStatus explícito e não é reativação, preserva
  if (!isReactivating && appointment.paymentStatus) {
    return appointment.paymentStatus;
  }

  const pkg = appointment.package;

  if (isReactivating) {
    return isPrepaidPackage(pkg) ? 'package_paid' : 'unpaid';
  }

  // Estado default para novos appointments com pacote pré-pago
  if (!appointment.paymentStatus && isPrepaidPackage(pkg)) {
    return 'package_paid';
  }

  return appointment.paymentStatus || 'unpaid';
}

/**
 * Hook para invalidação de cache/disponibilidade.
 * Ainda placeholder — será implementado na Etapa 3+.
 */
export async function invalidateAvailability(appointment) {
  if (!appointment) return;

  // Futuro: invalidar cache de slots, notificar workers, publicar evento
  // Hoje: garante que o hook existe e é estável
  return true;
}

/**
 * Recomputa e dispara sincronização de projeções afetadas.
 */
export async function syncProjections(appointment, correlationId = null) {
  if (!appointment) return;

  const packageId = (appointment.package?._id || appointment.package)?.toString?.();
  const patientId = appointment.patient?.toString?.() || appointment.patient;

  await syncAffectedViews({
    event: 'appointment.updated',
    packageId,
    patientId,
    correlationId,
  });

  return true;
}

/**
 * Orquestrador principal de consistência de Appointment.
 *
 * @param {Object} params
 * @param {Object} params.appointment - Appointment original (antes do update)
 * @param {Object|null} params.session - Session vinculada (opcional)
 * @param {Object} params.updates - campos que serão aplicados no appointment
 * @param {mongoose.ClientSession|null} params.mongoSession
 * @param {string|null} params.correlationId
 *
 * @returns {Promise<Object>} - { paymentStatus, isReactivating }
 */
export async function appointmentStateOrchestrator({
  appointment,
  session = null,
  updates = {},
  mongoSession = null,
  correlationId = null,
}) {
  if (!appointment) {
    throw new Error('[appointmentStateOrchestrator] appointment é obrigatório');
  }

  const merged = { ...appointment, ...updates };

  const wasCanceled = CANCELED_STATUSES.includes(appointment.operationalStatus);
  const isReactivating =
    wasCanceled &&
    ['scheduled', 'pending', 'confirmed'].includes(updates.operationalStatus);

  // 1. RECOMPUTA PAYMENT STATUS (se necessário)
  const paymentStatus = recomputeAppointmentPaymentStatus(merged, isReactivating);

  // 2. SINCRONIZA SESSION A PARTIR DO APPOINTMENT
  //    A Session segue o Appointment. Sempre.
  const sessionToSync = session || merged;
  await syncSessionFromAppointment(
    { ...merged, paymentStatus },
    mongoSession
  );

  // 3. INVALIDA DISPONIBILIDADE (hook futuro)
  await invalidateAvailability({ ...merged, paymentStatus });

  // 4. REATIVA PROJEÇÕES
  await syncProjections({ ...merged, paymentStatus }, correlationId);

  console.log(
    `[appointmentStateOrchestrator] sync concluído para appointment ${appointment._id} | reativação=${isReactivating} | paymentStatus=${paymentStatus}`
  );

  return {
    paymentStatus,
    isReactivating,
  };
}

export default {
  appointmentStateOrchestrator,
  recomputeAppointmentPaymentStatus,
  invalidateAvailability,
  syncProjections,
};
