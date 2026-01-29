import { getTodayPartsInTZ, ymdNumber } from "./time.js";

function pad2(n) {
    return n.toString().padStart(2, '0');
}

export function extractPreferredDateFromText(text = "", tz = "America/Sao_Paulo") {
    const now = getTodayPartsInTZ(tz);
    const todayNum = ymdNumber(now);

    // Extrai dd/mm do texto (ex: "15/02" ou "quero dia 15/02")
    const match = text.match(/(\d{1,2})[\/\-](\d{1,2})/);
    if (!match) return null;

    let d = parseInt(match[1], 10);   // dia
    let mo = parseInt(match[2], 10);  // mês
    let y = now.year;

    // Se a data já passou, vai pro ano que vem
    let candidateNum = ymdNumber({ year: y, month: mo, day: d });
    if (candidateNum < todayNum) y += 1;

    return `${y}-${pad2(mo)}-${pad2(d)}`;
} s