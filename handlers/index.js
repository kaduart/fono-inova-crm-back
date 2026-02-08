// handlers/index.js - VERSÃO SIMPLIFICADA (V5)
// Handlers legados foram movidos para /legacy
// Apenas BookingHandler é mantido ativo

import bookingHandler from './BookingHandler.js';
import ProductQuestionHandler from './ProductQuestionHandler.js';

// 📝 STUBS para compatibilidade (handlers legados movidos para legacy/)
const fallbackHandler = {
  async execute() {
    console.log('[STUB] fallbackHandler - usar WhatsAppOrchestrator diretamente');
    return { text: 'Como posso te ajudar? 💚' };
  }
};

const productHandler = {
  async execute() {
    console.log('[STUB] productHandler - usar WhatsAppOrchestrator diretamente');
    return { text: 'Qual especialidade você procura? 💚' };
  }
};

const therapyHandler = {
  async execute() {
    console.log('[STUB] therapyHandler - usar WhatsAppOrchestrator diretamente');
    return { text: 'Me conta mais sobre a situação 💚' };
  }
};

const leadQualificationHandler = {
  async execute() {
    console.log('[STUB] leadQualificationHandler - usar WhatsAppOrchestrator diretamente');
    return { text: 'Qual a idade do paciente? 💚' };
  }
};

const productQuestionHandler = ProductQuestionHandler;

export { fallbackHandler };
export { productHandler, therapyHandler };
export { bookingHandler };
export { leadQualificationHandler };
export { productQuestionHandler };
export { complaintCollectionHandler } from './complaintCollectionHandler.js';
