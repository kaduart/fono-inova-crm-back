export const NON_BLOCKING_OPERATIONAL_STATUSES = [
  'canceled',
  'cancelado',
  'cancelada',
  // 🚨 FIX: pre_agendado foi removido - agora pré-agendamentos BLOQUEIAM o slot
  // para evitar duplicatas e race conditions no agendamento
];