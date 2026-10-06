import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';
// Middleware de validação para as rotas
export const validateGoogleAdsData = (req, res, next) => {
    // Verificar se customer_id é válido
    if (!/^\d+$/.test(process.env.GOOGLE_ADS_CUSTOMER_ID)) {
        return sendApiError(
          res,
          new AppError('INTERNAL_ERROR', 'Customer ID do Google Ads inválido', {
            status: 500,
          }),
          req
        );
    }
    next();
};