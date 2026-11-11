/**
 * Motivos de inativação do paciente (Kadu, 09/11/2026).
 * Lista fixa para dar para filtrar depois e montar campanhas de retorno
 * (quem saiu por preço, por horário, por alta etc.). A chave é o que fica no
 * banco; o rótulo é só da tela. Para incluir um motivo, acrescente aqui e no
 * front (src/constants/patientInactivationReasons.ts).
 */
export const PATIENT_INACTIVATION_REASONS = Object.freeze({
  alta: 'Alta / objetivo atingido',
  financeiro: 'Financeiro / preço',
  horario: 'Horário ou distância',
  mudou_cidade: 'Mudou de cidade',
  saude: 'Saúde / cirurgia',
  convenio: 'Convênio (não cobre ou mudou)',
  outra_clinica: 'Foi para outra clínica',
  insatisfacao: 'Insatisfação',
  sem_resposta: 'Parou de responder',
  outro: 'Outro',
});

export function isValidInactivationReason(reason) {
  return typeof reason === 'string' && Object.prototype.hasOwnProperty.call(PATIENT_INACTIVATION_REASONS, reason);
}

export function getInactivationReasonLabel(reason) {
  return isValidInactivationReason(reason) ? PATIENT_INACTIVATION_REASONS[reason] : null;
}
