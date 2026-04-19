/**
 * ============================================================================
 * PACKAGE BILLING SERVICE V2
 * ============================================================================
 * 
 * Responsabilidade: Criar/converter pacotes de convênio
 * 
 * REGRA CRÍTICA:
 * - Se já existe sessão agendada para a primeira → REAPROVEITA
 * - Se não existe → CRIA TUDO do zero
 * 
 * Fluxo:
 * 1. Verificar se existe sessão para primeira data/hora
 * 2. Se existir: vincula ao pacote, converte payment
 * 3. Se não existir: cria appointment + session + payment novo
 * ============================================================================
 */

import mongoose from 'mongoose';
import { v4 as uuidv4 } from 'uuid';
import Session from '../../../models/Session.js';
import Appointment from '../../../models/Appointment.js';
import Payment from '../../../models/Payment.js';
import { publishEvent } from '../../../infrastructure/events/eventPublisher.js';
import { insuranceBillingService } from './insuranceBillingService.v2.js';

export class PackageBillingService {
  
  /**
   * Cria ou converte pacote de convênio
   * 
   * @param {Object} data - Dados do pacote
   * @param {string} data.patientId - ID do paciente
   * @param {string} data.doctorId - ID do profissional
   * @param {string} data.insuranceGuideId - ID da guia
   * @param {Array} data.selectedSlots - Slots selecionados [{date, time}, ...]
   * @param {string} data.correlationId - ID de rastreamento
   */
  async createOrConvertPackage(data, options = {}) {
    const correlationId = options.correlationId || uuidv4();
    const { patientId, doctorId, insuranceGuideId, selectedSlots } = data;
    
    console.log(`[PackageV2] Processing package`, { 
      patientId, 
      slots: selectedSlots.length,
      correlationId 
    });

    const results = {
      packageId: null,
      sessions: [],
      appointments: [],
      payments: [],
      reused: 0,
      created: 0
    };

    const mongoSession = await mongoose.startSession();
    
    try {
      await mongoSession.startTransaction();

      // Busca guia
      const Guide = mongoose.model('InsuranceGuide');
      const guide = await Guide.findById(insuranceGuideId).session(mongoSession);
      
      if (!guide) {
        throw new Error('InsuranceGuide not found');
      }

      // Processa cada slot
      for (let i = 0; i < selectedSlots.length; i++) {
        const slot = selectedSlots[i];
        const isFirstSession = i === 0;
        
        // TENTA REAPROVEITAR (só na primeira)
        if (isFirstSession) {
          const existing = await this.findExistingSession(
            patientId, 
            doctorId, 
            slot.date, 
            slot.time,
            mongoSession
          );
          
          if (existing) {
            console.log(`[PackageV2] Reusing existing session: ${existing._id}`);
            
            // Converte para pacote
            const converted = await this.convertExistingToPackage(
              existing,
              guide,
              mongoSession,
              correlationId
            );
            
            results.sessions.push(converted.session);
            results.appointments.push(converted.appointment);
            results.payments.push(converted.payment);
            results.reused++;
            continue;
          }
        }
        
        // CRIA NOVO (não existe ou não é a primeira)
        console.log(`[PackageV2] Creating new session for slot ${i}`);
        
        const created = await this.createNewPackageSession(
          {
            patientId,
            doctorId,
            guide,
            slot,
            sessionNumber: i + 1,
            isFirst: isFirstSession
          },
          mongoSession,
          correlationId
        );
        
        results.sessions.push(created.session);
        results.appointments.push(created.appointment);
        results.payments.push(created.payment);
        results.created++;
      }

      await mongoSession.commitTransaction();
      
      // Publica evento
      await publishEvent('INSURANCE_PACKAGE_CREATED', {
        packageId: results.sessions[0]?.package?.toString(),
        patientId,
        guideId: guide._id,
        totalSessions: results.sessions.length,
        reused: results.reused,
        created: results.created
      }, { correlationId });

      return {
        success: true,
        ...results,
        correlationId
      };

    } catch (error) {
      await mongoSession.abortTransaction();
      throw error;
    } finally {
      mongoSession.endSession();
    }
  }

  /**
   * Busca sessão existente para reaproveitar
   */
  async findExistingSession(patientId, doctorId, date, time, mongoSession) {
    // Busca por session que já existe para esse slot
    const session = await Session.findOne({
      patient: patientId,
      doctor: doctorId,
      date: new Date(date),
      time: time,
      status: { $in: ['scheduled', 'confirmed'] },
      // Não pode já estar em outro pacote
      $or: [
        { packageId: { $exists: false } },
        { packageId: null }
      ]
    }).session(mongoSession);

    return session;
  }

  /**
   * Converte sessão avulsa existente para pacote
   */
  async convertExistingToPackage(session, guide, mongoSession, correlationId) {
    // 1. Atualiza Session
    session.paymentMethod = 'convenio';
    session.insuranceGuide = guide._id;
    session.notes = `${session.notes || ''} | Convertido para pacote`.trim();
    await session.save({ session: mongoSession });

    // 2. Busca e atualiza Appointment
    const appointment = await Appointment.findOne({
      session: session._id
    }).session(mongoSession);

    if (appointment) {
      appointment.paymentMethod = 'convenio';
      appointment.billingType = 'convenio';
      appointment.insuranceProvider = guide.insurance;
      appointment.authorizationCode = guide.number;
      await appointment.save({ session: mongoSession });
    }

    // 3. Busca e atualiza Payment (converte valor)
    let payment = await Payment.findOne({
      session: session._id
    }).session(mongoSession);

    if (payment) {
      // Recalcula para valor do pacote
      const packageValue = await this.calculatePackageSessionValue(guide);
      
      payment.paymentMethod = 'convenio';
      payment.billingType = 'convenio';
      payment.amount = packageValue;
      payment.insurance = {
        provider: guide.insurance,
        authorizationCode: guide.number,
        status: 'pending',
        grossAmount: packageValue,
        netAmount: packageValue
      };
      await payment.save({ session: mongoSession });
    } else {
      // Cria payment se não existia
      payment = await this.createPackagePayment(
        session,
        guide,
        mongoSession
      );
    }

    return { session, appointment, payment };
  }

  /**
   * Cria nova sessão para pacote
   */
  async createNewPackageSession(data, mongoSession, correlationId) {
    const { patientId, doctorId, guide, slot, sessionNumber } = data;

    // 1. Cria Session
    const session = new Session({
      patient: patientId,
      doctor: doctorId,
      specialty: guide.specialty,
      date: new Date(slot.date),
      time: slot.time,
      status: 'scheduled',
      paymentType: 'convenio',
      paymentMethod: 'convenio',
      insuranceGuide: guide._id,
      sessionValue: 0,
      isPaid: false,
      notes: `Pacote Convênio - Guia #${guide.number}`
    });

    await session.save({ session: mongoSession });

    // 2. Cria Appointment
    const appointment = new Appointment({
      patient: patientId,
      doctor: doctorId,
      specialty: guide.specialty,
      date: slot.date,
      time: slot.time,
      duration: 40,
      session: session._id,
      serviceType: 'convenio_session',
      operationalStatus: 'scheduled',
      clinicalStatus: 'pending',
      paymentMethod: 'convenio',
      billingType: 'convenio',
      insuranceProvider: guide.insurance,
      insuranceValue: 0,
      authorizationCode: guide.number,
      paymentStatus: 'pending_receipt',
      visualFlag: 'pending',
      notes: `Pacote Convênio - Guia #${guide.number}`
    });

    await appointment.save({ session: mongoSession });

    // 3. Vincula Session ↔ Appointment
    session.appointmentId = appointment._id;
    await session.save({ session: mongoSession });

    // 4. Cria Payment
    const payment = await this.createPackagePayment(
      session,
      guide,
      mongoSession
    );

    return { session, appointment, payment };
  }

  /**
   * Cria payment para sessão de pacote
   */
  async createPackagePayment(session, guide, mongoSession) {
    const packageValue = await this.calculatePackageSessionValue(guide);
    const month = new Date(session.date).toISOString().slice(0, 7);

    const payment = new Payment({
      patient: session.patient,
      doctor: session.doctor,
      session: session._id,
      appointment: session.appointmentId,
      serviceType: 'convenio_session',
      amount: packageValue,
      paymentMethod: 'convenio',
      billingType: 'convenio',
      status: 'pending_billing',
      insurance: {
        provider: guide.insurance,
        authorizationCode: guide.number,
        month,
        guideNumber: guide.number,
        status: 'pending',
        grossAmount: packageValue,
        netAmount: packageValue
      },
      appointments: [{
        appointment: session.appointmentId,
        amount: packageValue,
        guideNumber: guide.number
      }],
      serviceDate: session.date,
      notes: `Pacote Convênio - Guia ${guide.number}`
    });

    await payment.save({ session: mongoSession });
    return payment;
  }

  /**
   * Calcula valor da sessão no pacote
   */
  async calculatePackageSessionValue(guide) {
    // Aqui você implementa a lógica de valor do pacote
    // Por exemplo: valor tabela - desconto
    const convenioService = (await import('../../../services/convenioIntegrationService.js')).default;
    
    const value = await convenioService.getConvenioSessionValue(
      guide.insurance,
      guide.procedureCode || '201040',
      guide.specialty
    );

    // Aplica desconto de pacote se houver
    return value.grossAmount || 0;
  }
}

export const packageBillingService = new PackageBillingService();
export default packageBillingService;
