// Middleware para validação de pagamento
export const validateIndividualPayment = (req, res, next) => {
    if (req.body.serviceType === 'individual_session') {
        const { paymentAmount, paymentMethod } = req.body;
        
        if (!paymentAmount || paymentAmount <= 0) {
            return res.status(400).json({
                error: 'Valor inválido',
                message: 'Informe um valor válido para a sessão'
            });
        }
        
        if (!paymentMethod || !['dinheiro', 'pix', 'cartão'].includes(paymentMethod)) {
            return res.status(400).json({
                error: 'Método de pagamento inválido',
                message: 'Selecione um método de pagamento válido'
            });
        }
    }
    next();
};
