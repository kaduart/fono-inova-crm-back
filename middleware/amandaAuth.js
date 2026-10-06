/**
 * Middleware que aceita TANTO autenticação de usuário QUANTO token de serviço
 * Use nas rotas que Amanda precisa chamar
 */
import jwt from "jsonwebtoken";
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

const AGENDA_SERVICE_RULES = [
    // Appointments usados pela Agenda Externa.
    { methods: ['GET'], path: /^\/api\/v2\/appointments(?:\/(?:available-slots|convenio-options|[0-9a-fA-F]{24}))?$/ },
    { methods: ['POST'], path: /^\/api\/v2\/appointments$/ },
    { methods: ['PUT'], path: /^\/api\/v2\/appointments\/[^/]+$/ },
    { methods: ['PATCH'], path: /^\/api\/v2\/appointments\/[^/]+\/(?:admin-edit|cancel|confirm|post-appointment|reschedule)$/ },
    { methods: ['DELETE'], path: /^\/api\/v2\/appointments\/[^/]+$/ },

    // Pacotes: só leitura (a agenda não altera sessão de pacote por rota própria).
    { methods: ['GET'], path: /^\/api\/v2\/packages$/ },

    // Cadastros manipulados pelas telas atuais da Agenda.
    { methods: ['GET'], path: /^\/api\/v2\/patients$/ },
    { methods: ['PUT'], path: /^\/api\/v2\/patients\/[^/]+$/ },
    { methods: ['GET'], path: /^\/api\/v2\/doctors\/active$/ },
    { methods: ['POST'], path: /^\/api\/v2\/doctors$/ },
    { methods: ['DELETE'], path: /^\/api\/v2\/doctors\/[^/]+$/ },

    // Lembretes exibidos e atualizados pela Agenda.
    { methods: ['GET', 'POST'], path: /^\/api\/reminders$/ },
    { methods: ['GET', 'PATCH'], path: /^\/api\/reminders\/[^/]+$/ },
];

function requestPath(req) {
    const raw = req.originalUrl || req.url || '';
    const path = raw.split('?')[0].replace(/\/+$/, '');
    return path || '/';
}

export function isAgendaServiceRequestAllowed(req) {
    const method = String(req.method || '').toUpperCase();
    const path = requestPath(req);
    return AGENDA_SERVICE_RULES.some(
        rule => rule.methods.includes(method) && rule.path.test(path)
    );
}

export const flexibleAuth = (req, res, next) => {
    const raw = req.headers.authorization || "";
    const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : null;

    if (!token) {
        return sendApiError(res, new AppError('UNAUTHORIZED', "Token não fornecido", { status: 401 }), req);
    }

    // ✅ service token Amanda ou Agenda
    const serviceTokens = new Set(
        [process.env.ADMIN_API_TOKEN, process.env.AGENDA_EXPORT_TOKEN].filter(Boolean)
    );

    if (serviceTokens.has(token)) {
        const isAgendaService = token === process.env.AGENDA_EXPORT_TOKEN;

        if (isAgendaService && !isAgendaServiceRequestAllowed(req)) {
            return sendApiError(
              res,
              new AppError('AGENDA_SERVICE_SCOPE_DENIED', 'Agenda Externa não tem permissão para esta operação', {
                status: 403,
              }),
              req
            );
        }

        req.user = {
            id: isAgendaService ? "agenda-service" : "amanda-service",
            // O token da Agenda é distribuído no bundle do navegador: identifica o
            // canal, mas não pode conceder privilégio administrativo transversal.
            role: isAgendaService ? "agenda_service" : "admin",
            isService: true,
        };
        return next();
    }

    // ✅ JWT normal
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        return next();
    } catch (err) {
        return sendApiError(res, new AppError('UNAUTHORIZED', "Token inválido", { status: 401 }), req);
    }
};
