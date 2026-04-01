// services/appointmentV2Service.js
/**
 * Service V2 - Interface para fluxo Event-Driven 4.0
 * 
 * Este service é chamado pelo Proxy quando as feature flags
 * indicam que deve usar o fluxo 4.0
 */

import { createOutboxEvent } from '../workers/outboxWorker.js';
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';
import Appointment from '../models/Appointment.js';
import mongoose from 'mongoose';
import { Messages, formatSuccess } from '../utils/apiMessages.js';

/**
 * Cria agendamento via fluxo 4.0 (async)
 */
export async function createAppointment(data, context = {}) {
  const mongoSession = await mongoose.startSession();
  
  try {
    await mongoSession.startTransaction();
    
    const {
      patientId,
      doctorId,
      date,
      time,
      specialty = 'fonoaudiologia',
      packageId = null,
      insuranceGuideId = null,
      paymentMethod = 'dinheiro',
      amount = 0,
      notes = ''
    } = data;
    
    // Cria appointment com status processing
    const appointment = new Appointment({
      patient: patientId,
      doctor: doctorId,
      date,
      time,
      specialty,
      package: packageId,
      insuranceGuide: insuranceGuideId,
      operationalStatus: 'processing_create',
      clinicalStatus: 'pending',
      paymentStatus: 'pending',
      sessionValue: amount,
      paymentMethod,
      billingType: insuranceGuideId ? 'convenio' : (packageId ? 'particular' : 'particular'),
      notes,
      createdBy: context.userId,
      history: [{
        action: 'create_requested',
        newStatus: 'processing_create',
        changedBy: context.userId,
        timestamp: new Date(),
        context: 'Criação via 4.0 (Proxy)'
      }]
    });
    
    await appointment.save({ session: mongoSession });
    
    const idempotencyKey = `${appointment._id}_create`;
    
    await mongoSession.commitTransaction();
    
    // Publica evento
    const eventResult = await publishEvent(
      EventTypes.APPOINTMENT_CREATE_REQUESTED,
      {
        appointmentId: appointment._id.toString(),
        patientId: patientId?.toString(),
        doctorId: doctorId?.toString(),
        date,
        time,
        specialty,
        packageId: packageId?.toString(),
        insuranceGuideId: insuranceGuideId?.toString(),
        amount,
        paymentMethod,
        notes,
        userId: context.userId?.toString()
      },
      {
        correlationId: appointment._id.toString(),
        idempotencyKey
      }
    );
    
    return formatSuccess(
      {
        appointmentId: appointment._id.toString(),
        status: 'processing_create',
        correlationId: eventResult.correlationId,
        idempotencyKey: eventResult.idempotencyKey,
        eventId: eventResult.eventId
      },
      {
        message: Messages.PROCESSING.CREATE,
        processing: 'async',
        estimatedTime: '1-3s',
        checkStatus: `GET /api/v2/appointments/${appointment._id}/status`
      }
    );
    
  } catch (error) {
    await mongoSession.abortTransaction();
    throw error;
  } finally {
    mongoSession.endSession();
  }
}

/**
 * Completa agendamento via fluxo 4.0
 */
export async function completeAppointment(id, data, context = {}) {
  const appointment = await Appointment.findById(id);
  
  if (!appointment) {
    throw new Error('APPOINTMENT_NOT_FOUND');
  }
  
  const { addToBalance = false, balanceAmount = 0, balanceDescription = '' } = data;
  
  // Publica evento de complete
  const eventResult = await publishEvent(
    EventTypes.APPOINTMENT_COMPLETE_REQUESTED,
    {
      appointmentId: id,
      patientId: appointment.patient?._id?.toString(),
      doctorId: appointment.doctor?._id?.toString(),
      packageId: appointment.package?._id?.toString(),
      sessionId: appointment.session?._id?.toString(),
      addToBalance,
      balanceAmount: balanceAmount || appointment.sessionValue,
      balanceDescription,
      userId: context.userId?.toString()
    },
    {
      correlationId: id,
      idempotencyKey: `${id}_complete_${addToBalance ? 'balance' : 'normal'}`
    }
  );
  
  return formatSuccess(
    {
      appointmentId: id,
      status: 'processing_complete',
      correlationId: eventResult.correlationId,
      idempotencyKey: eventResult.idempotencyKey
    },
    {
      message: Messages.PROCESSING.COMPLETE,
      processing: 'async',
      checkStatus: `GET /api/v2/appointments/${id}/status`
    }
  );
}

/**
 * Cancela agendamento via fluxo 4.0
 */
export async function cancelAppointment(id, data, context = {}) {
  const appointment = await Appointment.findById(id);
  
  if (!appointment) {
    throw new Error('APPOINTMENT_NOT_FOUND');
  }
  
  const { reason, confirmedAbsence = false } = data;
  
  const eventResult = await publishEvent(
    EventTypes.APPOINTMENT_CANCEL_REQUESTED,
    {
      appointmentId: id,
      patientId: appointment.patient?._id?.toString(),
      doctorId: appointment.doctor?._id?.toString(),
      packageId: appointment.package?._id?.toString(),
      sessionId: appointment.session?._id?.toString(),
      reason,
      confirmedAbsence,
      userId: context.userId?.toString()
    },
    {
      correlationId: id,
      idempotencyKey: `${id}_cancel`
    }
  );
  
  return formatSuccess(
    {
      appointmentId: id,
      status: 'processing_cancel',
      correlationId: eventResult.correlationId,
      idempotencyKey: eventResult.idempotencyKey
    },
    {
      message: Messages.PROCESSING.CANCEL,
      processing: 'async',
      checkStatus: `GET /api/v2/appointments/${id}/status`
    }
  );
}
