// utils/phone (inline aqui mesmo p/ ficar simples)
export const normalizeE164BR = (phone) => {
    if (!phone) return "";
    let s = String(phone).replace(/\D/g, ""); // só dígitos
    // remove zeros à esquerda
    s = s.replace(/^0+/, "");
    // garante DDI 55
    if (!s.startsWith("55")) s = "55" + s;
    // força "+"
    return "+" + s;
};

// ajuda para buscar por "rabo" do número (8–11 dígitos)
export const tailPattern = (phone, min = 8, max = 11) => {
    const digits = String(phone).replace(/\D/g, "");
    const tail = digits.slice(-max); // último bloco
    return new RegExp(`${tail.slice(-min)}$`); // termina com os últimos N
};

export function firstName(full) {
    if (!full || typeof full !== 'string') return 'Olá';
    const part = full.trim().split(/\s+/)[0];
    return part || 'Olá';
}