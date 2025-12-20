const TZ_SP = "America/Sao_Paulo";

function toSPDate(dateStr, timeStr) {
    // Constrói uma data “local” SP sem depender do timezone do servidor
    const [y, m, d] = dateStr.split("-").map(Number);
    const [hh, mm] = timeStr.split(":").map(Number);
    // Criar em UTC e depois comparar por “dia” via timestamp é ok se você sempre usar a mesma base
    return new Date(Date.UTC(y, m - 1, d, hh, mm, 0));
}

function normalizeUrgency(u) {
    const x = String(u || "NORMAL").toUpperCase();
    if (x === "MÉDIA" || x === "MEDIA") return "MEDIA";
    if (x === "ALTA") return "ALTA";
    return "NORMAL";
}

export function applyUrgencyRules(slots, urgencyLevel = "NORMAL") {
    if (!Array.isArray(slots)) return [];

    const level = normalizeUrgency(urgencyLevel);

    const now = new Date();
    const limitDays = level === "ALTA" ? 5 : level === "MEDIA" ? 7 : null;
    const take = level === "ALTA" ? 3 : level === "MEDIA" ? 5 : null;

    const cleaned = slots
        .map(s => ({ ...s, _dt: toSPDate(s.date, s.time) }))
        .filter(s => s._dt instanceof Date && !isNaN(s._dt) && s._dt >= now)
        .sort((a, b) => a._dt - b._dt);

    if (limitDays == null) return cleaned.map(({ _dt, ...s }) => s);

    const maxTs = now.getTime() + limitDays * 24 * 60 * 60 * 1000;

    const filtered = cleaned.filter(s => s._dt.getTime() <= maxTs);
    const sliced = take ? filtered.slice(0, take) : filtered;

    return sliced.map(({ _dt, ...s }) => s);
}

export const urgencyScheduler = applyUrgencyRules;