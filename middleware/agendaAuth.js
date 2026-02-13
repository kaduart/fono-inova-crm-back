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
        return res.status(401).json({ success: false, code: "NO_TOKEN", error: "Missing token" });
    }

    if (token !== process.env.AGENDA_EXPORT_TOKEN) {
        console.log("❌ TOKENS DIFERENTES!");
        return res.status(401).json({ success: false, code: "BAD_TOKEN", error: "Invalid token" });
    }

    console.log("✅ TOKEN VÁLIDO!");
    req.integration = { source: "agenda" };
    next();
}