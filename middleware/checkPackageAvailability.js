import Package from '../models/Package.js';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

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
            return sendApiError(
              res,
              new AppError('BAD_REQUEST', 'Informe o pacote ao criar a sessão', {
                status: 400,
                legacyError: 'packageId é obrigatório para sessão de pacote',
              }),
              req
            );
        }
        try {
            const pkg = await Package.findById(packageId);

            if (!pkg) {
                return sendApiError(
                  res,
                  new AppError('NOT_FOUND', 'Selecione outro pacote ou sessão avulsa', {
                    status: 404,
                    legacyError: 'Pacote não encontrado',
                  }),
                  req
                );
            }

            if (['canceled', 'cancelled'].includes(pkg.status)) {
                return sendApiError(
                  res,
                  new AppError('PACKAGE_INACTIVE', 'Este pacote foi inativado e não aceita novas sessões', {
                    status: 409,
                    legacyError: 'Pacote inativo',
                  }),
                  req
                );
            }

            if (pkg.remainingSessions <= 0) {
                return sendApiError(
                  res,
                  new AppError('BAD_REQUEST', 'Selecione outro pacote ou sessão avulsa', {
                    status: 400,
                    legacyError: 'Pacote sem sessões disponíveis',
                  }),
                  req
                );
            }

            // Anexar dados do pacote à requisição para uso posterior
            req.packageData = pkg;
        } catch (error) {
            console.error('Erro ao verificar pacote:', error);
            return sendApiError(
              res,
              new AppError('INTERNAL_ERROR', 'Erro ao verificar disponibilidade do pacote', {
                status: 500,
              }),
              req
            );
        }
    }
    next();
};
