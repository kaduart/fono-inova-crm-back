// services/communication/delivery/_deliveryUtils.js
//
// Utilitários compartilhados entre os DeliveryProviders.
// Mantém aqui qualquer lógica que não seja específica de um canal.

export const SUBJECT_BY_PURPOSE = {
  authorization: 'Solicitação de Autorização de Atendimento',
  billing: 'Solicitação de Faturamento',
  appeal: 'Solicitação de Recurso',
  documentation: 'Envio de Documentação'
};
