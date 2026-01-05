
// Extrai nome
export function extractName(msg) {
    const t = String(msg || "").trim();
    const m1 = t.match(/\b(nome|paciente)\s*[:\-]\s*([a-zÀ-ú\s]{3,80})/i);
    if (m1) return m1[2].trim();
    if (/^[a-zÀ-ú]{2,}\s+[a-zÀ-ú]{2,}/i.test(t) && t.length < 80) return t;
    return null;
};

// Extrai data de nascimento
export function extractBirth(msg) {
    const m = msg.match(/\b(\d{2})[\/\-](\d{2})[\/\-](\d{4})\b/);
    if (!m) return null;
    return `${m[3]}-${m[2]}-${m[1]}`;
};

/**
 * Extrai idade da mensagem (aceita "4", "4 anos", "tem 4", "fez 4", "4 aninhos")
 */
export function extractAgeFromText(text) {
    const t = (text || "").trim();

    // "4 anos", "4anos", "4 aninhos"
    const yearsMatch = t.match(/\b(\d{1,2})\s*(anos?|aninhos?)\b/i);
    if (yearsMatch) return { age: parseInt(yearsMatch[1]), unit: "anos" };

    // "7 meses", "7meses"
    const monthsMatch = t.match(/\b(\d{1,2})\s*(m[eê]s|meses)\b/i);
    if (monthsMatch) return { age: parseInt(monthsMatch[1]), unit: "meses" };

    // "tem 4", "fez 4", "completou 4"
    const fezMatch = t.match(/\b(?:tem|fez|completou)\s+(\d{1,2})\b/i);
    if (fezMatch) return { age: parseInt(fezMatch[1]), unit: "anos" };

    // Número puro "4" (só se for a mensagem inteira ou quase)
    const pureMatch = t.match(/^\s*(\d{1,2})\s*$/);
    if (pureMatch) return { age: parseInt(pureMatch[1]), unit: "anos" };

    return null;
}

/**
 * Extrai período da mensagem
 */
export function extractPeriodFromText(text) {
    const t = (text || "").toLowerCase();
    if (/\b(manh[ãa]|cedo)\b/.test(t)) return "manhã";  // ✅ FIX: com acento para match com schema
    if (/\b(tarde)\b/.test(t)) return "tarde";
    if (/\b(noite)\b/.test(t)) return "noite";
    return null;
}