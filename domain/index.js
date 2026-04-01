// domain/index.js
// Exporta todas as regras de domínio

// Session
export { cancelSession, findReusableCanceledSession, consumeCanceledSessionCredit } from './session/cancelSession.js';
export { completeSession } from './session/completeSession.js';

// Payment
export { cancelPayment, createPaymentForComplete, confirmPayment } from './payment/cancelPayment.js';

// Package
export { 
    consumePackageSession, 
    createPackageSession, 
    findAndConsumeReusableCredit,
    updatePackageFinancials 
} from './package/consumePackageSession.js';

// Insurance
export { consumeInsuranceGuide, createInsurancePayment } from './insurance/consumeInsuranceGuide.js';

// Liminar
export { recognizeLiminarRevenue } from './liminar/recognizeRevenue.js';
