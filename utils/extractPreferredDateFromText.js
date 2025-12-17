import { getTodayPartsInTZ, ymdNumber } from "./time.js";

export function extractPreferredDateFromText(text = "", tz = "America/Sao_Paulo") {
    const now = getTodayPartsInTZ(tz);
    const todayNum = ymdNumber(now);

    // ... quando for dd/mm sem ano:
    let y = now.year;
    // candidateNum com y atual
    let candidateNum = ymdNumber({ year: y, month: mo, day: d });

    if (candidateNum < todayNum) y += 1;
    return `${y}-${pad2(mo)}-${pad2(d)}`;
}