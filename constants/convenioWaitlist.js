// constants/convenioWaitlist.js
// Lista de INTERESSE em convênios (GEAP, IPASGO, Bradesco...) enquanto o credenciamento está em andamento.
// (Nome técnico "waitlist" mantido na API/coleção; na interface o termo é "lista de interesse".)
// Não confundir com `autoBookingContext.waitlist*` / status 'lista_espera' do Lead, que é a fila de horários da Amanda.

export const CONVENIOS_WAITLIST = ['geap', 'ipasgo', 'bradesco'];

export const CONVENIO_LABELS = {
    geap: 'GEAP',
    ipasgo: 'IPASGO',
    bradesco: 'Bradesco Saúde',
};

export const WAITLIST_STATUS = ['aguardando', 'contatado', 'agendado', 'descartado'];

// Status em que a pessoa ainda "está na lista" (só pode existir UM cadastro ativo por telefone + convênio)
export const WAITLIST_ACTIVE_STATUS = ['aguardando', 'contatado'];

// Versões do texto de consentimento (contato + privacidade) aceitas pelo backend.
// Ao mudar o texto no site, publicar uma nova versão aqui e no formulário do site.
export const WAITLIST_CONSENT_VERSIONS = ['convenio-interesse-2026-09'];

/** Chave de unicidade do cadastro ativo: garante, via índice único parcial, um ativo por telefone + convênio. */
export const waitlistActiveKey = (phone, convenio) => `${phone}:${convenio}`;

// Origem do cadastro: formulário do site ou conversa do WhatsApp Web (varredura/captura automática).
export const WAITLIST_CHANNELS = ['site', 'whatsapp_web'];

// Palavras que indicam interesse no convênio dentro de uma conversa do WhatsApp.
// O termo vai para a busca nativa do WhatsApp; o regex confirma no texto (evita falso positivo).
export const WAITLIST_WHATSAPP_KEYWORDS = {
    geap: { terms: ['geap'], regex: /\bgeap\b/i },
    ipasgo: { terms: ['ipasgo'], regex: /\bipasgo\b/i },
    bradesco: { terms: ['bradesco saude', 'bradesco saúde'], regex: /\bbradesco\s+sa[uú]de\b/i },
};

/** Convênios da lista de interesse citados no texto (ex.: "vocês atendem GEAP?" → ['geap']). */
export const matchWaitlistConvenios = (text) => {
    const body = String(text || '');
    if (!body) return [];
    return CONVENIOS_WAITLIST.filter((slug) => WAITLIST_WHATSAPP_KEYWORDS[slug]?.regex.test(body));
};
