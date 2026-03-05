// utils/phone.js - VERSÃO CORRIGIDA E ROBUSTA

// 👉 lista de números de teste (com 55 e 9 dígito)
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
 * 🔧 CORREÇÃO DEFINITIVA: Normaliza para E.164 BR (formato WhatsApp)
 * 
 * Regras:
 * 1. Remove tudo que não é dígito
 * 2. Garante prefixo 55 (Brasil)
 * 3. GARANTE o 9 dígito em celulares (se não tiver e for celular, adiciona)
 * 4. Remove 55 duplicado
 * 
 * Formato final: 55629123456789 (55 + DDD + 9 + número)
 * 
 * @param {string} phone - Telefone em qualquer formato
 * @returns {string|null} - Telefone normalizado ou null se inválido
 */
export const normalizeE164BR = (phone) => {
    if (!phone || String(phone).trim() === "") return null;

    let s = digitsOnly(phone);
    if (!s) return null;

    // Remove zeros à esquerda
    s = s.replace(/^0+/, "");

    // Se começa com +55, remove o +
    if (s.startsWith("+55")) {
        s = s.substring(1);
    }

    // Remove 55 duplicado (ex: 555562... → 5562...)
    if (s.startsWith("5555")) {
        s = s.substring(2);
    }

    // Se não começa com 55, adiciona
    if (!s.startsWith("55")) {
        s = "55" + s;
    }

    // Agora s tem formato: 55 + DDD + número
    // Celulares no Brasil devem ter: 55 (2) + DDD (2) + 9 (1) + número (8) = 13 dígitos
    // Fixos têm: 55 (2) + DDD (2) + número (8) = 12 dígitos

    // 🔧 REGRA: Adiciona 9 somente se o número estiver com 12 dígitos (faltando o 9)
    // Formato atual: 55DDXXXXXXXX (12 dígitos = sem o 9)
    // Formato alvo:  55DD9XXXXXXXX (13 dígitos = com o 9)
    if (s.length === 12) {
        // Tem 12 dígitos: 55 + DDD (2) + número (8) = falta o 9
        const ddd = s.substring(2, 4);
        const numero = s.substring(4); // 8 dígitos sem o 9
        
        // Se começar com 9, o número já está com 9 incluído (formato antigo: DD9XXXXXXXX sem 55)
        // Nesse caso, apenas adicionamos 55 na frente
        if (numero.startsWith("9")) {
            s = "55" + ddd + numero; // Já tem 9, só adiciona 55
            console.log(`📞 [PHONE] já tem 9: ${phone} → ${s}`);
        } else if (numero.charAt(0) >= "6" && numero.charAt(0) <= "9") {
            // Começa com 6,7,8 mas não com 9 → adiciona o 9
            s = "55" + ddd + "9" + numero;
            console.log(`📞 [PHONE] +9 (12→13): ${phone} → ${s}`);
        }
    } else if (s.length === 13) {
        // Já tem 13 dígitos: 55 + DDD + 9 + número = OK
        console.log(`📞 [PHONE] OK (13): ${phone} → ${s}`);
    } else if (s.length === 11 && !s.startsWith("55")) {
        // Não tem 55 no início, tem 11 dígitos: DDD + 9 + número
        // Adiciona 55 na frente
        s = "55" + s;
        console.log(`📞 [PHONE] +55: ${phone} → ${s}`);
    } else if (s.length === 10 && !s.startsWith("55")) {
        // Não tem 55 no início, tem 10 dígitos: DDD + número (sem 9)
        const ddd = s.substring(0, 2);
        const numero = s.substring(2);
        const primeiroDigito = parseInt(numero.charAt(0));
        
        if (primeiroDigito >= 6 && primeiroDigito <= 9) {
            s = "55" + ddd + "9" + numero;
            console.log(`📞 [PHONE] +55+9: ${phone} → ${s}`);
        } else {
            s = "55" + s;
            console.log(`📞 [PHONE] +55 (fixo?): ${phone} → ${s}`);
        }
    }

    // Validação final: deve ter entre 12 e 13 dígitos
    if (s.length < 12 || s.length > 14) {
        console.warn(`⚠️ [PHONE] Número inválido após normalização: ${s} (original: ${phone})`);
        // Retorna mesmo assim, pois pode ser um caso especial
    }

    return s;
};

/**
 * Normalização para COMPARAR telefones (ignora o 9 para comparação)
 * - Remove tudo que não é dígito
 * - Remove 55 se tiver
 * - Remove o 9 se for celular (para comparação)
 * - Corta pra no máximo 10 dígitos (DDD + número sem 9)
 */
export const normalizePhoneForCompare = (phone) => {
    if (!phone) return null;
    let d = digitsOnly(phone);
    if (!d) return null;

    // Remove 55 do início
    if (d.startsWith("55")) {
        d = d.slice(2);
    }

    // Se tem 11 dígitos (DDD + 9 + número), remove o 9 para comparação
    // formato: DD9XXXXXXXX
    if (d.length === 11 && d[2] === "9") {
        d = d.slice(0, 2) + d.slice(3); // Remove o 9
    }

    // Se ficou muito pequeno, não é confiável
    if (d.length < 8) return null;

    return d;
};

// ajuda para buscar por "rabo" do número (8–11 dígitos)
export const tailPattern = (phone, min = 8, max = 11) => {
    const digits = digitsOnly(phone);
    const tail = digits.slice(-max);
    return new RegExp(`${tail.slice(-min)}$`);
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
 */
const TEST_PATTERNS = AUTO_TEST_NUMBERS.map((n) => tailPattern(n, 8, 11));

export const isTestNumber = (phone) => {
    const digits = digitsOnly(phone);
    if (!digits) return false;
    return TEST_PATTERNS.some((re) => re.test(digits));
};

/**
 * 🆕 NOVO: Valida se o número está no formato correto E.164 para WhatsApp
 * Retorna objeto com status e mensagem de erro
 */
export const validateE164 = (phone) => {
    const normalized = normalizeE164BR(phone);
    
    if (!normalized) {
        return { valid: false, error: "Número vazio ou inválido", normalized: null };
    }

    // Deve começar com 55
    if (!normalized.startsWith("55")) {
        return { valid: false, error: "Número não começa com 55 (Brasil)", normalized };
    }

    // Tamanho esperado: 12 (fixo) ou 13 (celular)
    if (normalized.length !== 12 && normalized.length !== 13) {
        return { 
            valid: false, 
            error: `Tamanho incorreto: ${normalized.length} dígitos (esperado 12 ou 13)`, 
            normalized 
        };
    }

    // Extrai DDD
    const ddd = normalized.substring(2, 4);
    if (parseInt(ddd) < 11 || parseInt(ddd) > 99) {
        return { valid: false, error: `DDD inválido: ${ddd}`, normalized };
    }

    return { valid: true, error: null, normalized };
};

/**
 * 🔧 PRÉ-VALIDAÇÃO ROBUSTA: Sanitiza número antes de enviar para WhatsApp API
 * - Remove +, espaços, traços
 * - Corrige 9 duplicado
 * - Valida tamanho final
 * - Retorna { success, phone, error }
 */
export const sanitizePhoneBeforeSend = (phone) => {
    if (!phone) {
        return { success: false, phone: null, error: "Número vazio" };
    }

    let original = String(phone).trim();
    
    // Remove tudo que não é dígito (inclui +, espaços, traços, parênteses)
    let digits = original.replace(/\D/g, "");
    
    // Log para debug
    console.log(`📞 [SANITIZE] Original: "${original}" → Dígitos: "${digits}"`);
    
    // Se começar com 55, mantém. Se não, adiciona
    if (!digits.startsWith("55")) {
        // Se começar com +55 (já foi removido o +), adiciona 55
        if (original.startsWith("+55")) {
            digits = "55" + digits;
        } else {
            digits = "55" + digits;
        }
    }
    
    // Remove 55 duplicado
    if (digits.startsWith("5555")) {
        digits = digits.substring(2);
    }
    
    // 🔧 CORREÇÃO CRÍTICA: Verifica se tem 9 duplicado (14 dígitos = erro)
    // Formato errado: 55629992013573 (55 + 62 + 99 + 2013573)
    // Formato certo:  556292013573   (55 + 62 + 9  + 2013573)
    if (digits.length === 14) {
        // Extrai partes: 55 + DDD + resto
        const ddd = digits.substring(2, 4);
        const resto = digits.substring(4); // Deveria ser 9 + 8 dígitos
        
        // Se resto começa com 99, provavelmente é 9 duplicado
        if (resto.startsWith("99") && resto.length === 10) {
            // Remove o 9 extra
            digits = "55" + ddd + "9" + resto.substring(2);
            console.log(`📞 [SANITIZE] 9 duplicado corrigido: ${digits}`);
        }
    }
    
    // Validação final
    if (digits.length !== 12 && digits.length !== 13) {
        return { 
            success: false, 
            phone: digits, 
            error: `Tamanho inválido: ${digits.length} dígitos (esperado 12 ou 13 após 55)` 
        };
    }
    
    // Valida DDD
    const ddd = digits.substring(2, 4);
    if (parseInt(ddd) < 11 || parseInt(ddd) > 99) {
        return { success: false, phone: digits, error: `DDD inválido: ${ddd}` };
    }
    
    console.log(`📞 [SANITIZE] Sucesso: ${original} → ${digits}`);
    return { success: true, phone: digits, error: null };
};

export default {
    digitsOnly,
    normalizeE164BR,
    normalizePhoneForCompare,
    tailPattern,
    firstName,
    isTestNumber,
    validateE164,
    sanitizePhoneBeforeSend,
};
