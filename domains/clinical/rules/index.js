// back/domains/clinical/rules/index.js
/**
 * Clinical Domain Rules - Entry Point
 * 
 * Exporta todas as regras de negócio do domínio clínico.
 * 
 * Estas regras foram extraídas de:
 * - whatsappController.js
 * - leadController.js
 * - doctorController.js
 * - financialDashboardController.js
 * - convenioPackageController.js
 * - appointmentCompleteService.js
 * - createAppointmentService.js
 */

export { PatientRules } from './patientRules.js';
export { SessionRules } from './sessionRules.js';
export { AppointmentRules } from './appointmentRules.js';

// Regras individuais para importação específica
export { 
  PatientLookupRules,
  LeadConversionRules,
  PatientPackageRules,
  PatientValidationRules
} from './patientRules.js';

export {
  DoctorSessionViewRules,
  ProductionCalculationRules,
  PendingReceiptRules,
  SessionCompletionRules,
  SessionStatusRules,
  SessionCreationRules
} from './sessionRules.js';

export {
  AppointmentValidationRules,
  InitialPaymentStatusRules,
  OperationalStatusRules,
  ClinicalStatusRules,
  AppointmentCompletionRules,
  AppointmentCancellationRules,
  AppointmentRescheduleRules,
  AppointmentQueryRules
} from './appointmentRules.js';

// Namespace unificado
import { PatientRules } from './patientRules.js';
import { SessionRules } from './sessionRules.js';
import { AppointmentRules } from './appointmentRules.js';

export const ClinicalRules = {
  Patient: PatientRules,
  Session: SessionRules,
  Appointment: AppointmentRules
};

export default ClinicalRules;
