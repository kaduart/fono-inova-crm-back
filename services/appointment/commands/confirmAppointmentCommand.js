// back/services/appointment/commands/confirmAppointmentCommand.js
/**
 * Confirm Appointment Command
 *
 * Responsabilidade: marcar um agendamento como confirmado pelo profissional
 * e refletir o estado na Session vinculada.
 */

import mongoose from 'mongoose';
import Appointment from '../../../models/Appointment.js';
import Session from '../../../models/Session.js';
import { resolveAndMapAppointmentDTO } from '../../../utils/appointmentDto.js';
import { syncEvent } from '../../syncService.js';
import { emitSocket } from '../helpers/socketHelper.js';
import { buildError, checkDoctorPermission } from './_helpers.js';

export async function execute(id, user) {
  const session = await mongoose.startSession();

  try {
    await session.startTransaction();
    const appointment = await Appointment.findById(id).session(session);

    if (!appointment) {
      throw buildError('Agendamento não encontrado', 404, 'APPOINTMENT_NOT_FOUND');
    }

    checkDoctorPermission(appointment, user);

    const oldStatus = appointment.operationalStatus;
    appointment.operationalStatus = 'confirmed';
    appointment.clinicalStatus = 'pending';

    if (!appointment.history) appointment.history = [];
    appointment.history.push({
      action: 'confirmação_presença_manual',
      changedBy: user?._id,
      timestamp: new Date(),
      context: 'operacional',
      details: { from: oldStatus, to: 'confirmed' },
    });

    const updatedAppointment = await appointment.save({ session, validateBeforeSave: false });

    if (appointment.session) {
      await Session.findByIdAndUpdate(
        appointment.session,
        {
          $set: {
            status: 'completed',
            updatedAt: new Date(),
          },
        },
        { session }
      );
    }

    await session.commitTransaction();

    setTimeout(() => syncEvent(updatedAppointment, 'appointment').catch(console.error), 100);

    return {
      data: await resolveAndMapAppointmentDTO(updatedAppointment),
      message: 'Agendamento confirmado com sucesso',
    };
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    throw error;
  } finally {
    await session.endSession();
  }
}

export default { execute };
