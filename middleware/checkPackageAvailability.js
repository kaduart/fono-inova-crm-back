import Package from '../models/Package.js';

// 🚨 FIX (patch operacional Particular/Pacote): o valor real de serviceType para
// sessão de pacote é 'package_session' (packageController.v2.js, packageService.ts
// no front) — nunca 'package'. Com a condição antiga essa checagem nunca disparava
// de verdade para o fluxo real, então a capacidade do pacote nunca era validada
// antes da escrita em POST /v2/appointments. Também faltava o import de Package
// (ReferenceError silenciado pelo catch, retornando 500 genérico se algum dia
// o valor batesse).
export const checkPackageAvailability = async (req, res, next) => {
    if (req.body.serviceType === 'package_session') {
        const packageId = req.body.package || req.body.packageId;
        if (!packageId) {
            return res.status(400).json({
                error: 'packageId é obrigatório para sessão de pacote',
                message: 'Informe o pacote ao criar a sessão'
            });
        }
        try {
            const pkg = await Package.findById(packageId);

            if (!pkg) {
                return res.status(404).json({
                    error: 'Pacote não encontrado',
                    message: 'Selecione outro pacote ou sessão avulsa'
                });
            }

            if (['canceled', 'cancelled'].includes(pkg.status)) {
                return res.status(409).json({
                    error: 'Pacote inativo',
                    code: 'PACKAGE_INACTIVE',
                    message: 'Este pacote foi inativado e não aceita novas sessões'
                });
            }

            if (pkg.remainingSessions <= 0) {
                return res.status(400).json({
                    error: 'Pacote sem sessões disponíveis',
                    message: 'Selecione outro pacote ou sessão avulsa'
                });
            }

            // Anexar dados do pacote à requisição para uso posterior
            req.packageData = pkg;
        } catch (error) {
            console.error('Erro ao verificar pacote:', error);
            return res.status(500).json({ error: 'Erro ao verificar disponibilidade do pacote' });
        }
    }
    next();
};
