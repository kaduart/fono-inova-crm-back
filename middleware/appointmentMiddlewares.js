import Joi from 'joi';

// Esquema base para POST/PUT
const baseSchema = Joi.object({
    doctorId: Joi.string().hex().length(24).required(),
    patientId: Joi.string().hex().length(24).required(),
    date: Joi.date().iso().required(),
    time: Joi.string().pattern(/^([01]\d|2[0-3]):([0-5]\d)$/).required(),
    serviceType: Joi.string().valid(
        'individual_session', 'package_session', 'evaluation'
    ).required(),
    // ... outros campos
});

export const validateAppointment = (req, res, next) => {
    let schema = baseSchema;

    // Adicionar regras específicas
    if (req.body.serviceType === 'individual_session') {
        schema = schema.keys({
            sessionValue: Joi.number().min(0.01).required(),
            paymentMethod: Joi.string().valid('dinheiro', 'pix', 'cartão').required()
        });
    }

    if (req.body.serviceType === 'package_session') {
        schema = schema.keys({
            packageId: Joi.string().hex().length(24).required()
        });
    }

    const { error } = schema.validate(req.body, { abortEarly: false });

    if (error) {
        const errors = error.details.map(detail => ({
            field: detail.path.join('.'),
            message: detail.message
        }));

        return res.status(400).json({
            error: 'Validação falhou',
            details: errors
        });
    }

    next();
};

// Middleware para verificar pacotes
export const checkPackageAvailability = async (req, res, next) => {
    if (req.body.serviceType === 'package_session') {
        try {
            const packages = await Package.findById(req.body.packageId);

            if (!packages || packages.remainingSessions <= 0) {
                return res.status(400).json({
                    error: 'Pacote sem sessões disponíveis',
                    message: 'Selecione outro pacote ou sessão avulsa'
                });
            }

            req.packageData = packages;
        } catch (error) {
            return res.status(500).json({ error: 'Erro ao verificar disponibilidade do pacote' });
        }
    }
    next();
};

// Middleware para pagamentos individuais
export const validateIndividualPayment = (req, res, next) => {
    if (req.body.serviceType === 'individual_session') {
        const { sessionValue, paymentMethod } = req.body;

        if (!sessionValue || sessionValue <= 0) {
            return res.status(400).json({
                error: 'Valor inválido',
                message: 'Informe um valor válido para a sessão'
            });
        }

        if (!paymentMethod) {
            return res.status(400).json({
                error: 'Método de pagamento ausente',
                message: 'Selecione um método de pagamento'
            });
        }
    }
    next();
};