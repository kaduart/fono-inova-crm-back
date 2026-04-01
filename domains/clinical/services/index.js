// back/domains/clinical/services/index.js
/**
 * Clinical Domain Services - Entry Point
 * 
 * Exporta todos os services do domínio clínico.
 * 
 * Usage:
 *   import { PatientService, SessionService, AppointmentService } from './domains/clinical/services/index.js';
 *   
 *   const { patient, event } = await PatientService.createPatient(data, context);
 */

export { PatientService, ClinicalEventTypes as PatientEventTypes } from './patientService.js';
export { SessionService, SessionEventTypes } from './sessionService.js';
export { AppointmentService, AppointmentEventTypes } from './appointmentService.js';

// Exporta tudo como namespace ClinicalServices
import { PatientService } from './patientService.js';
import { SessionService } from './sessionService.js';
import { AppointmentService } from './appointmentService.js';

export const ClinicalServices = {
  Patient: PatientService,
  Session: SessionService,
  Appointment: AppointmentService
};

export default ClinicalServices;
