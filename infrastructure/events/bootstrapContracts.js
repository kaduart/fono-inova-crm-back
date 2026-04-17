// infrastructure/events/bootstrapContracts.js
/**
 * Bootstrap dos Event Contracts.
 * Deve ser importado UMA vez no início da aplicação (server.js ou workers).
 */

import { registerAppointmentEventContracts } from '../../domains/appointment/contracts/AppointmentEvents.contract.js';
import { registerPaymentEventContracts } from '../../domains/billing/contracts/PaymentEvents.contract.js';
import { registerPatientEventContracts } from '../../domains/clinical/contracts/PatientEvents.contract.js';
import { registerNotificationEventContracts } from '../../domains/notification/contracts/NotificationEvents.contract.js';

let bootstrapped = false;

export function bootstrapEventContracts() {
    if (bootstrapped) return;

    registerAppointmentEventContracts();
    registerPaymentEventContracts();
    registerPatientEventContracts();
    registerNotificationEventContracts();

    bootstrapped = true;
    console.log('📜 Event Contracts registrados');
}
