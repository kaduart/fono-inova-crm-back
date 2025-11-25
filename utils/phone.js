// utils/phone.js (ou utils/phones.js)

// 👉 lista de números de teste (só precisa manter aqui)
const AUTO_TEST_NUMBERS = [
    "5561981694922",
    "556181694922",
    "556292013573",
    "5562992013573",
];

// mantém só dígitos
export const digitsOnly = (phone) => {
    if (!phone) return "";
    return String(phone).replace(/\D/g, "");
};

/**
 * Normaliza para E.164 BR (para ENVIAR via WhatsApp, etc)
 * - remove lixo
 * - remove zeros à esquerda
 * - garante prefixo 55
 * - NÃO inventa nem tira 9, só respeita o que veio
 * 
 * Retorna string tipo "5562981694922" (sem +) – que a API do WhatsApp aceita.
 * Se você preferir sempre com "+", é só mudar o return.
 */
export const normalizeE164BR = (phone) => {
    if (!phone || String(phone).trim() === "") return null;

    let s = digitsOnly(phone);
    if (!s) return null;

    // tira zeros à esquerda
    s = s.replace(/^0+/, "");

    // se não começa com 55, adiciona
    if (!s.startsWith("55")) {
        s = "55" + s;
    }

    return s; // "5562...."
};

// ajuda para buscar por "rabo" do número (8–11 dígitos)
export const tailPattern = (phone, min = 8, max = 11) => {
    const digits = digitsOnly(phone);
    const tail = digits.slice(-max); // último bloco
    return new RegExp(`${tail.slice(-min)}$`); // termina com os últimos N
};

/**
 * Normalização para COMPARAR telefones
 * - remove tudo que não é dígito
 * - remove 55 se tiver
 * - corta pra no máximo 11 dígitos (DDD + número)
 * - se ficar muito curto (<8) retorna null
 *
 * Use isso para:
 * - bater lead x patient
 * - bater banco x WhatsApp
 * - checar isTestNumber
 */
export const normalizePhoneForCompare = (phone) => {
    if (!phone) return null;
    let d = digitsOnly(phone);
    if (!d) return null;

    // se começa com 55 e tem mais de 11, tira o 55
    if (d.startsWith("55") && d.length > 11) {
        d = d.slice(2);
    }

    // se ainda tiver grande demais, pega só os últimos 11
    if (d.length > 11) {
        d = d.slice(-11);
    }

    // se ficou muito pequeno, não é confiável
    if (d.length < 8) return null;

    return d; // tipo "62981694922" ou "6292197657"
};

/**
 * Nome simples a partir do nome completo
 */
export function firstName(full) {
    if (!full || typeof full !== "string") return "Olá";
    const part = full.trim().split(/\s+/)[0];
    return part || "Olá";
}

/**
 * Usa "rabo" do número para entender se é número de teste
 * Isso resolve a treta do 9:
 * - AUTO_TEST_NUMBERS tem algumas variações
 * - a comparação olha para os últimos dígitos
 */
const TEST_PATTERNS = AUTO_TEST_NUMBERS.map((n) => tailPattern(n, 8, 11));

export const isTestNumber = (phone) => {
    const digits = digitsOnly(phone);
    if (!digits) return false;
    return TEST_PATTERNS.some((re) => re.test(digits));
};
