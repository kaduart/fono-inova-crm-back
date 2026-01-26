const strip = (s) =>
    String(s || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");

export const normalizePeriod = (p) => {
    const n = strip(p);
    if (n.includes("manh")) return "manha";
    if (n.includes("tard")) return "tarde";
    if (n.includes("noit")) return "noite";
    return null;
};

const matchesPeriod = (time) => {
    const want = normalizePeriod(preferredPeriod);
    if (!want) return true;
    return normalizePeriod(getTimePeriod(time)) === want;
};
