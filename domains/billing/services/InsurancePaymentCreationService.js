/**
 * ============================================================================
 * INSURANCE PAYMENT CREATION SERVICE
 * ============================================================================
 *
 * Serviço central para criação/atualização de recebíveis de convênio.
 * Garante a regra de ouro: no máximo 1 Payment ativo de convênio por Session.
 *
 * Responsabilidades:
 * - Busca ativa por session + billingType (fonte canônica)
 * - Fallback por appointment (não ressuscita cancelados)
 * - Fallback por orphan (session OU appointment)
 * - Criação com proteção contra race condition (captura 11000)
 * - Atualização preservando vínculos corretos
 *
 * Por que existe:
 *   O Payment é a fonte de verdade financeira do convênio. Duplicidades aqui
 *   causam double-counting no dashboard, caixa e recebíveis. Este serviço
 *   centraliza a idempotência para que nenhum fluxo (handler legado, Billing V2,
 *   geração de plano) precise reimplementar a lógica.
 * ============================================================================
 */

import mongoose from 'mongoose';
import Payment from '../../../models/Payment.js';
import { handlePaymentEvent } from '../../../projections/paymentsProjection.js';

const TERMINAL_STATUSES = ['canceled', 'refunded', 'converted_to_package', 'recognized', 'consumed'];

function isActivePayment(payment) {
  if (!payment) return false;
  return !TERMINAL_STATUSES.includes(payment.status);
}

function toObjectId(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  const str = value.toString?.() || value;
  if (mongoose.Types.ObjectId.isValid(str)) {
    return new mongoose.Types.ObjectId(str);
  }
  // Preserva o valor original quando não é um ObjectId válido (ex: mocks de teste
  // usam strings como 'session-1'). Em produção os IDs sempre são ObjectIds reais.
  return value;
}

export class InsurancePaymentCreationService {
  /**
   * Busca ou cria um Payment de convênio vinculado a uma Session/Appointment.
   *
   * @param {Object} params
   * @param {string|ObjectId} params.sessionId       - Session de origem (chave canônica)
   * @param {string|ObjectId} params.appointmentId     - Appointment de origem (fallback)
   * @param {string|ObjectId} [params.appointmentPaymentId] - Payment explicitamente linkado ao appointment
   * @param {string|ObjectId} params.patientId       - Paciente (obrigatório se não estiver em paymentData)
   * @param {Object} params.paymentData              - Dados a serem gravados/atualizados
   * @param {mongoose.ClientSession} params.mongoSession - Transação do Mongoose
   * @param {boolean} [params.allowCreate=true]      - Permite criar novo se não encontrar
   *
   * @returns {Promise<{payment: Payment|null, created: boolean, source: string|null}>}
   */
  async findOrCreateConvenioPayment({
    sessionId,
    appointmentId,
    appointmentPaymentId,
    patientId,
    paymentData = {},
    mongoSession,
    allowCreate = true
  }) {
    const sessionObjectId = toObjectId(sessionId);
    const appointmentObjectId = toObjectId(appointmentId);

    if (!sessionId && !appointmentId) {
      throw new Error('INVALID_INPUT: sessionId ou appointmentId é obrigatório');
    }

    let existing = null;
    let source = null;

    // 1. FONTE CANÔNICA: Payment ativo vinculado à SESSION.
    //    session + billingType é a chave real do atendimento; appointment.payment
    //    pode apontar para registro cancelado/legado e não deve ser única fonte.
    if (sessionObjectId) {
      existing = await Payment.findOne({
        session: sessionObjectId,
        billingType: 'convenio'
      }).session(mongoSession).lean();

      if (existing && isActivePayment(existing)) {
        source = 'session_active';
      } else if (existing) {
        existing = null; // NUNCA ressuscita payment cancelado/refunded
      }
    }

    // 2. FALLBACK: Payment ativo vinculado ao APPOINTMENT.
    if (!existing && appointmentObjectId) {
      // 2a. Se o appointment aponta explicitamente para um payment, valida se está ativo.
      //     NUNCA ressuscita payment cancelado/refunded apontado por appointment.payment.
      const explicitPaymentId = toObjectId(appointmentPaymentId);
      if (explicitPaymentId) {
        const explicit = await Payment.findById(explicitPaymentId).session(mongoSession).lean();
        if (explicit && explicit.billingType === 'convenio' && isActivePayment(explicit)) {
          existing = explicit;
          source = 'appointment_payment_explicit';
        }
      }

      // 2b. Caso contrário, busca qualquer payment ativo por appointment.
      if (!existing) {
        existing = await Payment.findOne({
          appointment: appointmentObjectId,
          billingType: 'convenio',
          status: { $nin: TERMINAL_STATUSES }
        }).session(mongoSession).lean();

        if (existing) {
          source = 'appointment_active';
        }
      }
    }

    // 3. FALLBACK DEFENSIVO: orphan ativo por session OU appointment.
    //    Cobre casos onde vínculos foram perdidos ou gerados em processos separados.
    if (!existing && (sessionObjectId || appointmentObjectId)) {
      const orConditions = [];
      if (sessionObjectId) orConditions.push({ session: sessionObjectId });
      if (appointmentObjectId) orConditions.push({ appointment: appointmentObjectId });

      existing = await Payment.findOne({
        $or: orConditions,
        billingType: 'convenio',
        status: { $nin: TERMINAL_STATUSES }
      }).session(mongoSession).lean();

      if (existing) {
        source = 'orphan_active';
      }
    }

    // 4. ATUALIZA Payment encontrado.
    if (existing) {
      const updateData = { ...paymentData };

      // Garante vínculos corretos (não deixa paymentData sobrescrever por null)
      if (sessionObjectId) updateData.session = sessionObjectId;
      if (appointmentObjectId) updateData.appointment = appointmentObjectId;
      if (patientId) updateData.patient = toObjectId(patientId);

      // Não permite billingType diferente de convenio neste serviço
      updateData.billingType = 'convenio';

      const updated = await Payment.findByIdAndUpdate(
        existing._id,
        { $set: updateData },
        { session: mongoSession, new: true }
      );

      // 🔄 Atualiza PaymentsView (read-model)
      try {
        await handlePaymentEvent({
          type: 'PAYMENT_UPDATED',
          payload: { paymentId: updated._id.toString() },
          timestamp: new Date().toISOString()
        });
      } catch (viewErr) {
        console.warn('[InsurancePaymentCreationService] Falha ao atualizar PaymentsView (non-fatal):', viewErr.message);
      }

      console.log(`[InsurancePaymentCreationService] Payment atualizado: ${updated._id} (source=${source})`);
      return { payment: updated, created: false, source };
    }

    // 5. CRIA novo Payment.
    if (!allowCreate) {
      return { payment: null, created: false, source: null };
    }

    const newPaymentData = {
      ...paymentData,
      billingType: 'convenio',
      patient: toObjectId(patientId) || paymentData.patient,
      session: sessionObjectId,
      appointment: appointmentObjectId
    };

    try {
      const [created] = await Payment.create([newPaymentData], { session: mongoSession });
      console.log(`[InsurancePaymentCreationService] Payment criado: ${created._id} (session=${sessionObjectId})`);

      // 🔄 Atualiza PaymentsView (read-model)
      try {
        await handlePaymentEvent({
          type: 'PAYMENT_CREATED',
          payload: { paymentId: created._id.toString() },
          timestamp: new Date().toISOString()
        });
      } catch (viewErr) {
        console.warn('[InsurancePaymentCreationService] Falha ao atualizar PaymentsView (non-fatal):', viewErr.message);
      }

      return { payment: created, created: true, source: 'created' };
    } catch (err) {
      // 🛡️ RACE CONDITION: o índice único parcial disparou — outro processo criou
      // o payment entre o findOne e o create. Recupera e atualiza em vez de falhar.
      if (err.code === 11000 || err.message?.includes('E11000')) {
        console.warn(`[InsurancePaymentCreationService] Race condition 11000 para session=${sessionObjectId}, recuperando existente`);

        const raced = await Payment.findOne({
          session: sessionObjectId,
          billingType: 'convenio'
        }).session(mongoSession).lean();

        if (raced) {
          const updateData = { ...paymentData };
          if (sessionObjectId) updateData.session = sessionObjectId;
          if (appointmentObjectId) updateData.appointment = appointmentObjectId;
          if (patientId) updateData.patient = toObjectId(patientId);
          updateData.billingType = 'convenio';

          const updated = await Payment.findByIdAndUpdate(
            raced._id,
            { $set: updateData },
            { session: mongoSession, new: true }
          );

          // 🔄 Atualiza PaymentsView (read-model)
          try {
            await handlePaymentEvent({
              type: 'PAYMENT_UPDATED',
              payload: { paymentId: updated._id.toString() },
              timestamp: new Date().toISOString()
            });
          } catch (viewErr) {
            console.warn('[InsurancePaymentCreationService] Falha ao atualizar PaymentsView (non-fatal):', viewErr.message);
          }

          return { payment: updated, created: false, source: 'race_condition_recovered' };
        }
      }

      throw err;
    }
  }
}

export const insurancePaymentCreationService = new InsurancePaymentCreationService();
export default insurancePaymentCreationService;
