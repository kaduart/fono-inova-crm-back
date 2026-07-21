// constants/fiscalEvents.js
// Códigos oficiais de tipoEvento do Sistema Nacional NFS-e (Anexo II).
// Fonte: back/docs/nfse-fiscal-module/event_matrix.md (v1.01, 22/01/2026) — 16 códigos confirmados,
// validados contra a versão de homologação de 2022. Nunca inferir/adivinhar código novo — se um tipo
// de evento não estiver aqui, é lacuna a resolver na documentação oficial, não a completar por analogia.

export const TipoEvento = {
  CANCELAMENTO: 101101,
  CANCELAMENTO_POR_SUBSTITUICAO: 105102,
  SOLICITACAO_ANALISE_FISCAL_CANCELAMENTO: 101103,
  CANCELAMENTO_DEFERIDO_ANALISE_FISCAL: 105104,
  CANCELAMENTO_INDEFERIDO_ANALISE_FISCAL: 105105,
  MANIFESTACAO_CONFIRMACAO_PRESTADOR: 202201,
  MANIFESTACAO_CONFIRMACAO_TOMADOR: 203202,
  MANIFESTACAO_CONFIRMACAO_INTERMEDIARIO: 204203,
  MANIFESTACAO_CONFIRMACAO_TACITA: 205204,
  MANIFESTACAO_REJEICAO_PRESTADOR: 202205,
  MANIFESTACAO_REJEICAO_TOMADOR: 203206,
  MANIFESTACAO_REJEICAO_INTERMEDIARIO: 204207,
  MANIFESTACAO_ANULACAO_REJEICAO: 205208,
  CANCELAMENTO_POR_OFICIO: 305101,
  BLOQUEIO_POR_OFICIO: 305102,
  DESBLOQUEIO_POR_OFICIO: 305103
};

// Categoria: 1 dígito inicial do código (estrutura oficial: [Categoria][Autor][Ambiente][Sequencial])
export const FiscalEventCategoria = {
  CANCELAMENTOS: 1,
  MANIFESTACOES: 2,
  OFICIOS: 3
};

// Legenda oficial de autor (event_matrix.md, Seção 2) — divergência conhecida e não resolvida:
// eventos MANIFESTACAO_CONFIRMACAO_TACITA e MANIFESTACAO_ANULACAO_REJEICAO têm texto "MIncid" na
// versão 2026 mas dígito de autor "05" (=MEmis) — tratar o código numérico como autoritativo, não o texto.
export const FiscalEventAutor = {
  EMITE: 'emite',
  PRESTADOR: 'prestador',
  TOMADOR: 'tomador',
  INTERMEDIARIO: 'intermediario',
  MEMIS: 'memis',
  MINCID: 'mincid',
  MAN: 'man',
  RESP_TRIB: 'resp_trib',
  CGNFSE: 'cgnfse'
};

// Estados terminais da NFS-e (event_matrix.md, Seção 3.3) — nenhum evento subsequente é aceito
export const TERMINAL_TIPOS_EVENTO = [
  TipoEvento.CANCELAMENTO,
  TipoEvento.CANCELAMENTO_POR_SUBSTITUICAO,
  TipoEvento.CANCELAMENTO_DEFERIDO_ANALISE_FISCAL,
  TipoEvento.CANCELAMENTO_POR_OFICIO
];

// Tipos de evento que podem ser alvo de Bloqueio/Desbloqueio por Ofício (#15/#16)
export const BLOQUEAVEIS_TIPOS_EVENTO = [
  TipoEvento.CANCELAMENTO,
  TipoEvento.CANCELAMENTO_POR_SUBSTITUICAO,
  TipoEvento.CANCELAMENTO_DEFERIDO_ANALISE_FISCAL,
  TipoEvento.CANCELAMENTO_INDEFERIDO_ANALISE_FISCAL,
  TipoEvento.CANCELAMENTO_POR_OFICIO
];

// Eventos de manifestação — não mudam FiscalInvoice.status, só populam sub-histórico (Fase 2, Seção 3)
export const MANIFESTACAO_TIPOS_EVENTO = [
  TipoEvento.MANIFESTACAO_CONFIRMACAO_PRESTADOR,
  TipoEvento.MANIFESTACAO_CONFIRMACAO_TOMADOR,
  TipoEvento.MANIFESTACAO_CONFIRMACAO_INTERMEDIARIO,
  TipoEvento.MANIFESTACAO_CONFIRMACAO_TACITA,
  TipoEvento.MANIFESTACAO_REJEICAO_PRESTADOR,
  TipoEvento.MANIFESTACAO_REJEICAO_TOMADOR,
  TipoEvento.MANIFESTACAO_REJEICAO_INTERMEDIARIO,
  TipoEvento.MANIFESTACAO_ANULACAO_REJEICAO
];
