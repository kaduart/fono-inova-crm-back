export const checkPackageAvailability = async (req, res, next) => {
    if (req.body.serviceType === 'package') {
        try {
            const packages = await Package.findById(req.body.packageId);

            if (!packages || packages.remainingSessions <= 0) {
                return res.status(400).json({
                    error: 'Pacote sem sessões disponíveis',
                    message: 'Selecione outro pacote ou sessão avulsa'
                });
            }

            // Anexar dados do pacote à requisição para uso posterior
            req.packageData = packages;
        } catch (error) {
            console.error('Erro ao verificar pacote:', error);
            return res.status(500).json({ error: 'Erro ao verificar disponibilidade do pacote' });
        }
    }
    next();
};
