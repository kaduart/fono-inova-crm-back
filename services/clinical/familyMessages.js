// Textos que vão para a família (itens 3 e 4 da sprint prontuário, 03/11/2026).
// Funções puras: o terapeuta sempre revisa e aprova antes de qualquer envio.
// Regras de tom da Fono Inova: curto (2–3 frases), acolhedor, 1 💚 no final, sem link cru.

export const firstName = (name = '') => String(name).trim().split(/\s+/)[0] || '';

const listPt = (items) => {
    const xs = items.filter(Boolean);
    if (xs.length <= 1) return xs[0] || '';
    return `${xs.slice(0, -1).join(', ')} e ${xs[xs.length - 1]}`;
};

/** Marcador que o terapeuta precisa trocar antes de enviar. */
export const PLACEHOLDER_RE = /\[[^\]]*\]/;

export function familySummarySuggestion({ patientName, areas = [] }) {
    const nome = firstName(patientName) || 'seu filho(a)';
    const worked = listPt(areas.map(a => String(a?.name || a || '').toLowerCase()).filter(Boolean).slice(0, 3));
    const first = worked
        ? `Olá! Na sessão de hoje, ${nome} trabalhou ${worked}.`
        : `Olá! Passando o resumo da sessão de hoje do(a) ${nome}.`;
    return `${first} [conte um avanço da sessão] Para casa: [uma dica simples para a semana]. Qualquer dúvida, estamos por aqui 💚`;
}

export function monthlyReportMessage({ patientName, monthLabel, doctorName }) {
    const nome = firstName(patientName) || 'seu filho(a)';
    const quem = doctorName ? ` com ${firstName(doctorName)}` : '';
    return `Olá! O relatório de ${monthLabel} do acompanhamento do(a) ${nome}${quem} está pronto. [destaque principal do mês] Se quiser conversar sobre ele, é só responder aqui 💚`;
}

/** Valida o texto final; devolve mensagem de erro em pt-BR ou null. */
export function validateFamilyText(text) {
    const t = String(text || '').trim();
    if (t.length < 20) return 'Escreva o resumo antes de enviar.';
    if (t.length > 1000) return 'O resumo está longo demais para o WhatsApp (máximo 1000 caracteres).';
    if (PLACEHOLDER_RE.test(t)) return 'Troque os trechos entre colchetes antes de enviar.';
    return null;
}

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export const monthLabelPt = (month) => {
    const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
    return m ? `${MONTHS[Number(m[2]) - 1]} de ${m[1]}` : String(month || '');
};
