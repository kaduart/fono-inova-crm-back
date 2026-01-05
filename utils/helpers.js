export default function ensureSingleHeart(text) {
    if (!text) return "Como posso te ajudar? 💚";

    let clean = text.replace(/💚/g, "").trim();

    clean = clean.replace(
        /^(obrigad[oa]\s*,?\s+[a-zÀ-ú]+(?:\s+[a-zÀ-ú]+)*)/i,
        (match) => {
            return /obrigada/i.test(match) ? "Obrigada" : "Obrigado";
        }
    );

    clean = clean.replace(
        /^(oi|olá|ola)\s*,?\s+[a-zÀ-ú]+(?:\s+[a-zÀ-ú]+)*/i,
        (match, oi) => {
            return oi.charAt(0).toUpperCase() + oi.slice(1).toLowerCase();
        }
    );

    clean = clean.trim();

    return `${clean} 💚`;
}