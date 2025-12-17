// utils/time.js
export function getTodayPartsInTZ(tz = "America/Sao_Paulo") {
    const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    }).formatToParts(new Date());

    const get = (type) => parts.find((p) => p.type === type)?.value;
    return {
        year: Number(get("year")),
        month: Number(get("month")),
        day: Number(get("day")),
    };
}

export function ymdNumber({ year, month, day }) {
    return year * 10000 + month * 100 + day;
}
