// handlers/index.js
import { BookingHandler } from './BookingHandler.js';
import { FallbackHandler } from './FallbackHandler.js';
import LeadQualificationHandler from './LeadQualificationHandler.js';
import { ProductHandler } from './ProductHandler.js';
import ProductQuestionHandler from './ProductQuestionHandler.js';
import { TherapyHandler } from './TherapyHandler.js';

// Crie instâncias (singletons) - use NEW aqui
export const bookingHandler = new BookingHandler();
export const fallbackHandler = new FallbackHandler();
export const leadQualificationHandler = LeadQualificationHandler; // já é instância
export const productHandler = new ProductHandler();
export const therapyHandler = new TherapyHandler();
export const productQuestionHandler = ProductQuestionHandler; // já é instância