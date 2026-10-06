import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';
// Middleware para validação de pagamento
export const validateIndividualPayment = (req, res, next) => {
    if (req.body.serviceType === 'individual_session') {
        const { paymentAmount, paymentMethod } = req.body;
        
        if (!paymentAmount || paymentAmount <= 0) {
            return sendApiError(
              res,
              new AppError('BAD_REQUEST', 'Informe um valor válido para a sessão', {
                status: 400,
                legacyError: 'Valor inválido',
              }),
              req
            );
        }
        
        if (!paymentMethod || !['dinheiro', 'pix', 'cartão'].includes(paymentMethod)) {
            return sendApiError(
              res,
              new AppError('BAD_REQUEST', 'Selecione um método de pagamento válido', {
                status: 400,
                legacyError: 'Método de pagamento inválido',
              }),
              req
            );
        }
    }
    next();
};
