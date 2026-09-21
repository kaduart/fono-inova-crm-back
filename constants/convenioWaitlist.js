// constants/convenioWaitlist.js
// Lista de espera de convênios (GEAP, IPASGO, Bradesco...) enquanto o credenciamento não é liberado.
// Não confundir com `autoBookingContext.waitlist*` / status 'lista_espera' do Lead, que é a fila de horários da Amanda.

export const CONVENIOS_WAITLIST = ['geap', 'ipasgo', 'bradesco'];

export const CONVENIO_LABELS = {
    geap: 'GEAP',
    ipasgo: 'IPASGO',
    bradesco: 'Bradesco Saúde',
};

export const WAITLIST_STATUS = ['aguardando', 'contatado', 'agendado', 'descartado'];

// Status em que a pessoa ainda "está na lista" (usado para deduplicar novos cadastros)
export const WAITLIST_ACTIVE_STATUS = ['aguardando', 'contatado'];
