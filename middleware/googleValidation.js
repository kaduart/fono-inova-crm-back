// Middleware de validação para as rotas
export const validateGoogleAdsData = (req, res, next) => {
    // Verificar se customer_id é válido
    if (!/^\d+$/.test(process.env.GOOGLE_ADS_CUSTOMER_ID)) {
        return res.status(500).json({
            error: 'Customer ID do Google Ads inválido'
        });
    }
    next();
};