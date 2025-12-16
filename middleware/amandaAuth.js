/**
 * Middleware que aceita TANTO autenticação de usuário QUANTO token de serviço
 * Use nas rotas que Amanda precisa chamar
 */
import jwt from "jsonwebtoken";

export const flexibleAuth = (req, res, next) => {
    const raw = req.headers.authorization || "";
    const token = raw.startsWith("Bearer ") ? raw.slice(7).trim() : null;

    if (!token) {
        return res.status(401).json({ success: false, message: "Token não fornecido" });
    }

    // ✅ service token Amanda ou Agenda
    const serviceTokens = new Set(
        [process.env.ADMIN_API_TOKEN, process.env.AGENDA_EXPORT_TOKEN].filter(Boolean)
    );

    if (serviceTokens.has(token)) {
        req.user = {
            id: token === process.env.AGENDA_EXPORT_TOKEN ? "agenda-service" : "amanda-service",
            role: "admin",
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
        return res.status(401).json({ success: false, message: "Token inválido" });
    }
};
