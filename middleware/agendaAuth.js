import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';
export function agendaAuth(req, res, next) {
    if (req.method === "OPTIONS") return next();

    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;

    // Logs detalhados

    if (!token) {
        return sendApiError(res, new AppError("NO_TOKEN", "Missing token", { status: 401 }), req);
    }

    if (token !== process.env.AGENDA_EXPORT_TOKEN) {
        return sendApiError(res, new AppError("BAD_TOKEN", "Invalid token", { status: 401 }), req);
    }

    req.integration = { source: "agenda" };
    next();
}