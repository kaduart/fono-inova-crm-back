// middleware/domainStrict.js
export const strictDomain = (req, res, next) => {
    const allowedDomains = [
        'https://app.clinicafonoinova.com.br',
        'http://localhost:5173'
    ];

    const origin = req.headers.origin || req.headers.referer;

    if (!origin || !allowedDomains.some(domain => origin.includes(domain))) {
        console.log(`Bloqueado acesso de: ${origin}`);
        return res.status(403).json({
            error: 'Acesso não autorizado',
            requiredUrl: `https://app.clinicafonoinova.com.br${req.originalUrl}`
        });
    }
    next();
};

// Use EM TODAS as rotas:
app.use(strictDomain);