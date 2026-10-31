/**
 * Checagem de perfil para rotas que usam `auth` ou `flexibleAuth`.
 *
 * `flexibleAuth` aceita qualquer JWT válido (inclusive de terapeuta) e os
 * tokens de serviço. Estas funções fecham o perfil depois dele:
 *   - staff: admin e secretária (humanos) + serviço Amanda (role admin).
 *   - staffOrAgenda: staff + token da Agenda Externa (o escopo de rotas do
 *     token continua sendo validado em flexibleAuth).
 */
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

const STAFF = ['admin', 'secretary'];

function makeGuard(allowed, label) {
    return (req, res, next) => {
        const role = req.user?.role;
        if (role && allowed.includes(role)) return next();
        console.warn('[ROLE_DENIED]', label, req.method, req.originalUrl, '| role:', role || 'none');
        return sendApiError(
            res,
            new AppError('FORBIDDEN', 'Seu perfil não tem permissão para esta operação', { status: 403 }),
            req
        );
    };
}

export const requireStaff = makeGuard(STAFF, 'staff');
export const requireStaffOrAgenda = makeGuard([...STAFF, 'agenda_service'], 'staffOrAgenda');
export const requireAdmin = makeGuard(['admin'], 'admin');
