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
