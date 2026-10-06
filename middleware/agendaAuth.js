import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';
export function agendaAuth(req, res, next) {
    if (req.method === "OPTIONS") return next();

    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;

    // Logs detalhados
    console.log("=== AUTH DEBUG ===");
    console.log("Header completo:", JSON.stringify(header));
    console.log("Token extraído:", JSON.stringify(token));
    console.log("Token esperado:", JSON.stringify(process.env.AGENDA_EXPORT_TOKEN));
    console.log("Tamanho token recebido:", token?.length);
    console.log("Tamanho token esperado:", process.env.AGENDA_EXPORT_TOKEN?.length);
    console.log("São iguais?:", token === process.env.AGENDA_EXPORT_TOKEN);

    if (!token) {
        return sendApiError(res, new AppError("NO_TOKEN", "Missing token", { status: 401 }), req);
    }

    if (token !== process.env.AGENDA_EXPORT_TOKEN) {
        console.log("❌ TOKENS DIFERENTES!");
        return sendApiError(res, new AppError("BAD_TOKEN", "Invalid token", { status: 401 }), req);
    }

    console.log("✅ TOKEN VÁLIDO!");
    req.integration = { source: "agenda" };
    next();
}