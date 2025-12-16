export function agendaAuth(req, res, next) {
    if (req.method === "OPTIONS") return next();
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;

    if (!token) {
        return res.status(401).json({ success: false, code: "NO_TOKEN", error: "Missing token" });
    }

    if (token !== process.env.AGENDA_EXPORT_TOKEN) {
        return res.status(401).json({ success: false, code: "BAD_TOKEN", error: "Invalid token" });
    }

    req.integration = { source: "agenda" };
    next();
}