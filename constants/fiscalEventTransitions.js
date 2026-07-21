// constants/fiscalEventTransitions.js
// Matriz oficial evento×evento (event_matrix.md, Seção 3.3, Anexo II v1.01-20260122) — versão
// determinística usada pelo FiscalStateMachineService.
//
// ESCOPO DELIBERADAMENTE REDUZIDO (documentado, não silencioso):
// A matriz oficial completa tem 24 colunas (16 tipoEvento + 8 variantes de bloqueio/desbloqueio
// por evento-alvo). Aqui modelamos só:
//   1. A "família de cancelamento" (Cancelamento/Substituição/Análise Fiscal/Ofício) — 100%
//      determinística na fonte oficial, sem células condicionais.
//   2. Manifestações (Confirmação/Rejeição/Tácita/Anulação) tratadas como trilha PARALELA
//      (event_matrix.md Seção 3.2) — sempre aceitas enquanto a nota não estiver em estado
//      terminal, SEM tentar reproduzir os valores `X/V` condicionais das colunas 6-13 da matriz
//      oficial. A própria pesquisa da Fase 1.5 registrou essas células como lacuna não resolvida
//      ("regra adicional não detalhada... registrado como lacuna, não assumido no lugar da
//      fonte") — reproduzir um valor aqui seria inventar a regra que a fonte oficial não deu.
//   3. Bloqueio/Desbloqueio por Ofício tratados fora da matriz de "próximo evento aceito",
//      como uma flag independente (`blockedEventTypes` em FiscalInvoice) que veta a família de
//      cancelamento — não como transição de estado da nota em si.
//
// Se o CRM algum dia precisar theonomizar a regra exata das colunas 6-13 (bloqueio de
// manifestação duplicada pelo mesmo ator), isso exige nova pesquisa documental — não deve ser
// implementado por suposição.

import { TipoEvento, TERMINAL_TIPOS_EVENTO, MANIFESTACAO_TIPOS_EVENTO, BLOQUEAVEIS_TIPOS_EVENTO } from './fiscalEvents.js';

// Estado "nenhum evento ainda" — usado como chave inicial da família de cancelamento
export const NO_CANCELLATION_EVENT_YET = 'none';

// Linhas: último evento da família de cancelamento aplicado (ou NO_CANCELLATION_EVENT_YET).
// Valores: lista de tipoEvento da família de cancelamento aceitáveis como PRÓXIMO evento.
// Fonte: event_matrix.md Seção 3.3, colunas 1-5 e 14 de cada linha correspondente.
export const CANCELLATION_FAMILY_TRANSITIONS = {
  [NO_CANCELLATION_EVENT_YET]: [
    TipoEvento.CANCELAMENTO,
    TipoEvento.CANCELAMENTO_POR_SUBSTITUICAO,
    TipoEvento.SOLICITACAO_ANALISE_FISCAL_CANCELAMENTO,
    TipoEvento.CANCELAMENTO_POR_OFICIO
  ],
  [TipoEvento.SOLICITACAO_ANALISE_FISCAL_CANCELAMENTO]: [
    TipoEvento.CANCELAMENTO_DEFERIDO_ANALISE_FISCAL,
    TipoEvento.CANCELAMENTO_INDEFERIDO_ANALISE_FISCAL
  ],
  [TipoEvento.CANCELAMENTO_INDEFERIDO_ANALISE_FISCAL]: [
    TipoEvento.CANCELAMENTO_POR_OFICIO
  ]
  // Demais tipos da família (Cancelamento, Cancel.Substituição, Deferido, CancelOficio) são
  // terminais — ausência de entrada aqui = nenhuma transição aceita (ver TERMINAL_TIPOS_EVENTO).
};

export function isCancellationFamilyEvent(tipoEvento) {
  return [
    TipoEvento.CANCELAMENTO,
    TipoEvento.CANCELAMENTO_POR_SUBSTITUICAO,
    TipoEvento.SOLICITACAO_ANALISE_FISCAL_CANCELAMENTO,
    TipoEvento.CANCELAMENTO_DEFERIDO_ANALISE_FISCAL,
    TipoEvento.CANCELAMENTO_INDEFERIDO_ANALISE_FISCAL,
    TipoEvento.CANCELAMENTO_POR_OFICIO
  ].includes(tipoEvento);
}

export function isManifestationEvent(tipoEvento) {
  return MANIFESTACAO_TIPOS_EVENTO.includes(tipoEvento);
}

export function isBlockOrUnblockEvent(tipoEvento) {
  return tipoEvento === TipoEvento.BLOQUEIO_POR_OFICIO || tipoEvento === TipoEvento.DESBLOQUEIO_POR_OFICIO;
}

export function isTerminalCancellationEvent(tipoEvento) {
  return TERMINAL_TIPOS_EVENTO.includes(tipoEvento);
}

export { BLOQUEAVEIS_TIPOS_EVENTO };
