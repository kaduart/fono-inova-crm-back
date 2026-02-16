// services/billing/insuranceBilling.js
import mongoose from 'mongoose';
import guideService from './guideService.js';
import Session from '../../models/Session.js';
import Appointment from '../../models/Appointment.js';
import Payment from '../../models/Payment.js';
import { updatePatientAppointments } from '../../utils/appointmentUpdater.js';
import { validateDateTime, checkScheduleConflict } from '../../utils/billingHelpers.js';

/**
 * 💼 Insurance Billing Service
 *
 * Gerencia faturamento de sessões via convênio médico.
 *
 * Fluxo de pagamento:
 * 1. Criar appointment → Payment com status 'pending_billing'
 * 2. Enviar fatura → markSessionAsBilled() → status 'billed'
 * 3. Receber pagamento → markSessionAsReceived() → status 'paid'
 *
 * @module insuranceBilling
 */

class InsuranceBillingService {

  /**
   * Cria agendamento com cobrança via convênio
   *
   * Fluxo completo:
   * 1. Busca guia válida
   * 2. Verifica conflito de horário
   * 3. Cria Session + Appointment + Payment
   * 4. Consome sessão da guia
   * 5. Atualiza referências
   *
   * @param {Object} appointmentData - Dados do agendamento
   * @param {ObjectId|string} appointmentData.patientId - ID do paciente
   * @param {ObjectId|string} appointmentData.doctorId - ID do profissional
   * @param {string} appointmentData.specialty - Especialidade
   * @param {string} appointmentData.date - Data (YYYY-MM-DD)
   * @param {string} appointmentData.time - Horário (HH:mm)
   * @param {string} [appointmentData.notes] - Observações
   * @param {ObjectId|string} [appointmentData.insuranceGuideId] - ID da guia (opcional)
   * @param {ObjectId|string} [appointmentData.createdBy] - ID do usuário
   * @param {ClientSession} [mongoSession=null] - Sessão MongoDB
   *
   * @returns {Promise<Object>} Resultado estruturado
   * @throws {Error} PACIENTE_SEM_GUIA_ATIVA, CONFLITO_HORARIO, etc
   *
   * @example
   * const result = await insuranceBilling.createInsuranceAppointment({
   *   patientId: '507f1f77bcf86cd799439011',
   *   doctorId: '507f191e810c19729de860ea',
   *   specialty: 'fonoaudiologia',
   *   date: '2025-02-20',
   *   time: '14:00'
   * });
   */
  async createInsuranceAppointment(appointmentData, mongoSession = null) {
    // 1. Extrair dados do contexto
    const {
      patientId,
      doctorId,
      specialty,
      date,
      time,
      notes,
      insuranceGuideId,
      createdBy
    } = appointmentData;

    // 2. Iniciar transação (se não recebida)
    const session = mongoSession || await mongoose.startSession();
    const shouldCommit = !mongoSession;

    try {
      if (shouldCommit) {
        await session.startTransaction();
      }

      // 3. Validar formato de data/hora
      validateDateTime(date, time);

      // 4. Buscar guia válida
      const guide = await guideService.findValidGuide({
        patientId,
        specialty,
        date: new Date(`${date}T${time}`)
      });

      // 5. Verificar conflito de horário (dentro da transação)
      const conflict = await checkScheduleConflict({
        date,
        time,
        doctorId,
        patientId,
        specialty,
        session
      });

      if (conflict) {
        const error = new Error(
          'Já existe um agendamento para este paciente/profissional neste horário'
        );
        error.code = 'CONFLITO_HORARIO';
        throw error;
      }

      // 6. Criar Session (com referência à guia, mas SEM consumir)
      const newSession = new Session({
        patient: patientId,
        doctor: doctorId,
        specialty,
        date,
        time,
        sessionType: specialty,
        sessionValue: 0, // Convênio não tem valor de sessão definido
        status: 'scheduled',
        isPaid: false, // Será true quando convênio pagar
        paymentStatus: 'pending',
        visualFlag: 'pending',
        paymentMethod: 'convenio',
        insuranceGuide: guide._id, // 🔗 Vincula à guia (mas não consome ainda)
        notes: notes || `Guia: ${guide.number} | ${guide.insurance}`,
        _inFinancialTransaction: true
      });

      await newSession.save({ session, validateBeforeSave: false });

      // 7. Criar Appointment
      const newAppointment = new Appointment({
        patient: patientId,
        doctor: doctorId,
        specialty,
        date,
        time,
        duration: 40,
        session: newSession._id,
        serviceType: 'session',
        operationalStatus: 'scheduled',
        clinicalStatus: 'pending',
        paymentStatus: 'pending',
        visualFlag: 'pending',
        billingType: 'convenio',
        insuranceProvider: guide.insurance,
        insuranceValue: 0,
        authorizationCode: guide.number,
        notes
      });

      await newAppointment.save({ session, validateBeforeSave: false });

      // 8. Vincular Session ↔ Appointment
      newSession.appointmentId = newAppointment._id;
      await newSession.save({ session, validateBeforeSave: false });

      // 9. Criar Payment
      const payment = new Payment({
        patient: patientId,
        doctor: doctorId,
        session: newSession._id,
        appointment: newAppointment._id,
        serviceType: 'session',
        amount: 0, // Valor será definido no faturamento
        paymentMethod: 'convenio',
        status: 'pending', // Status inicial
        billingType: 'convenio',
        insurance: {
          provider: guide.insurance,
          authorizationCode: guide.number,
          status: 'pending_billing',
          grossAmount: 0
        },
        serviceDate: date,
        notes: `Aguardando faturamento - Guia ${guide.number}`
      });

      await payment.save({ session });

      // 10. ❌ REMOVIDO: consumo da guia (agora acontece quando Session.status = 'completed')

      // 11. Atualizar Appointment com Payment
      await Appointment.findByIdAndUpdate(
        newAppointment._id,
        { payment: payment._id },
        { session }
      );

      // 12. Atualizar Patient.appointments
      await updatePatientAppointments(patientId);

      // 13. Commit da transação (se criou aqui)
      if (shouldCommit) {
        await session.commitTransaction();
      }

      // 14. Retornar resultado estruturado
      const populatedAppointment = await Appointment.findById(newAppointment._id)
        .populate('patient', 'fullName cpf phone')
        .populate('doctor', 'fullName specialty')
        .populate('session')
        .populate('payment')
        .lean();

      return {
        success: true,
        appointment: populatedAppointment,
        session: newSession.toObject(),
        payment: payment.toObject(),
        guide: {
          _id: guide._id,
          number: guide.number,
          insurance: guide.insurance,
          remaining: guide.remaining, // Saldo atual (sem consumo)
          status: guide.status
        },
        message: `Agendamento criado (guia será consumida quando sessão for concluída)`,
        alert: guide.remaining <= 2 ? 'LOW_BALANCE' : null
      };

    } catch (error) {
      // Abortar transação se criou aqui
      if (shouldCommit && session.inTransaction()) {
        await session.abortTransaction();
      }
      throw error;

    } finally {
      // Finalizar sessão se criou aqui
      if (shouldCommit) {
        await session.endSession();
      }
    }
  }

  /**
   * Marca sessão como faturada (enviada para convênio)
   *
   * Quando clínica envia fatura para convênio
   *
   * @param {ObjectId|string} sessionId - ID da sessão
   * @param {Object} billingData - Dados do faturamento
   * @param {Date} [billingData.billedAt] - Data de envio da fatura
   * @param {number} [billingData.billedAmount] - Valor faturado
   * @param {string} [billingData.notes] - Observações
   * @param {ClientSession} [mongoSession=null] - Sessão MongoDB
   *
   * @returns {Promise<Object>} Resultado da operação
   *
   * @example
   * const result = await insuranceBilling.markSessionAsBilled(sessionId, {
   *   billedAt: new Date('2025-02-25'),
   *   billedAmount: 150.00
   * });
   */
  async markSessionAsBilled(sessionId, billingData, mongoSession = null) {
    const session = mongoSession || await mongoose.startSession();
    const shouldCommit = !mongoSession;

    try {
      if (shouldCommit) {
        await session.startTransaction();
      }

      const { billedAt = new Date(), billedAmount, notes } = billingData || {};

      // Atualizar Payment
      const updateData = {
        status: 'billed',
        'insurance.status': 'billed',
        'insurance.billedAt': billedAt
      };

      if (billedAmount !== undefined) {
        updateData.amount = billedAmount;
        updateData['insurance.grossAmount'] = billedAmount;
      }

      if (notes) {
        updateData.notes = notes;
      }

      await Payment.findOneAndUpdate(
        { session: sessionId },
        { $set: updateData },
        { session }
      );

      // Atualizar Session
      await Session.findByIdAndUpdate(
        sessionId,
        { $set: { paymentStatus: 'pending' } },
        { session }
      );

      // Atualizar Appointment
      await Appointment.findOneAndUpdate(
        { session: sessionId },
        { $set: { paymentStatus: 'pending' } },
        { session }
      );

      if (shouldCommit) {
        await session.commitTransaction();
      }

      return {
        success: true,
        message: 'Sessão marcada como faturada',
        data: {
          sessionId,
          billedAt,
          billedAmount: billedAmount || 0,
          status: 'billed'
        }
      };

    } catch (error) {
      if (shouldCommit && session.inTransaction()) {
        await session.abortTransaction();
      }
      throw error;

    } finally {
      if (shouldCommit) {
        await session.endSession();
      }
    }
  }

  /**
   * Marca sessão como recebida (convênio pagou)
   *
   * Quando convênio efetua o pagamento
   *
   * @param {ObjectId|string} sessionId - ID da sessão
   * @param {number} receivedAmount - Valor recebido
   * @param {Date} [receivedDate] - Data do recebimento
   * @param {ClientSession} [mongoSession=null] - Sessão MongoDB
   *
   * @returns {Promise<Object>} Resultado da operação
   *
   * @example
   * const result = await insuranceBilling.markSessionAsReceived(
   *   sessionId,
   *   140.00,
   *   new Date('2025-03-15')
   * );
   */
  async markSessionAsReceived(sessionId, receivedAmount, receivedDate, mongoSession = null) {
    const session = mongoSession || await mongoose.startSession();
    const shouldCommit = !mongoSession;

    try {
      if (shouldCommit) {
        await session.startTransaction();
      }

      const receiptDate = receivedDate || new Date();

      // Atualizar Payment
      await Payment.findOneAndUpdate(
        { session: sessionId },
        {
          $set: {
            status: 'paid',
            'insurance.status': 'received',
            'insurance.receivedAmount': receivedAmount,
            'insurance.receivedAt': receiptDate,
            paidAt: receiptDate,
            amount: receivedAmount
          }
        },
        { session }
      );

      // Atualizar Session
      await Session.findByIdAndUpdate(
        sessionId,
        {
          $set: {
            isPaid: true,
            paymentStatus: 'paid',
            visualFlag: 'ok',
            sessionValue: receivedAmount
          }
        },
        { session }
      );

      // Atualizar Appointment
      await Appointment.findOneAndUpdate(
        { session: sessionId },
        {
          $set: {
            paymentStatus: 'paid',
            visualFlag: 'ok',
            sessionValue: receivedAmount
          }
        },
        { session }
      );

      if (shouldCommit) {
        await session.commitTransaction();
      }

      return {
        success: true,
        message: 'Pagamento de convênio registrado',
        data: {
          sessionId,
          receivedAmount,
          receivedDate: receiptDate,
          status: 'paid'
        }
      };

    } catch (error) {
      if (shouldCommit && session.inTransaction()) {
        await session.abortTransaction();
      }
      throw error;

    } finally {
      if (shouldCommit) {
        await session.endSession();
      }
    }
  }

  /**
   * Constrói mensagem de sucesso personalizada
   * @private
   */
  _buildMessage(guideUpdate) {
    const { remaining, status } = guideUpdate;

    if (status === 'exhausted') {
      return 'Agendamento criado (guia esgotada)';
    }
    if (remaining <= 2) {
      return `Agendamento criado (⚠️ ${remaining} sessão(ões) restante(s))`;
    }
    return `Agendamento criado (${remaining} sessões restantes)`;
  }
}

// Exportar instância única (singleton)
export default new InsuranceBillingService();
