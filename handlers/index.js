import bookingHandler from './BookingHandler.js';
import fallbackHandler from './FallbackHandler.js';
import LeadQualificationHandler from './LeadQualificationHandler.js';
import productHandler from './ProductHandler.js';
import ProductQuestionHandler from './ProductQuestionHandler.js';
import therapyHandler from './TherapyHandler.js';

export { fallbackHandler };
export { productHandler, therapyHandler };
export { bookingHandler };
export const leadQualificationHandler = LeadQualificationHandler;
export const productQuestionHandler = ProductQuestionHandler;
