export const NON_BLOCKING_OPERATIONAL_STATUSES = [
  'canceled',
  'cancelado',
  'cancelada',
  'completed',
  'converted',
  // 🚨 FIX: pre_agendado foi removido - agora pré-agendamentos BLOQUEIAM o slot
  // para evitar duplicatas e race conditions no agendamento
];

// 🛡️ Status que identificam pré-agendamentos (não devem aparecer em listagens de appointments reais)
export const PRE_APPOINTMENT_STATUSES = ['pre_agendado', 'converted'];

// 🛡️ Status operacionais de cancelamento (variações legadas)
export const CANCELED_STATUSES = ['canceled', 'cancelado', 'cancelada'];