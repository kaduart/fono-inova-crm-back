// constants/fiscalEnums.js
// Enums centrais do módulo fiscal NFS-e. Fonte: back/docs/nfse-fiscal-module/
// (project_nfse_phase1_official_spec.md, dps_field_matrix.md, project_nfse_phase2_domain_model.md v3)
// Nunca duplicar estes valores em schemas/services/workers/controllers — sempre importar daqui.

export const FiscalInvoiceStatus = {
  DRAFT: 'draft',
  PENDING_SUBMISSION: 'pending_submission',
  AUTHORIZED: 'authorized',
  PENDING_FISCAL_ANALYSIS: 'pending_fiscal_analysis',
  CANCELLED: 'cancelled',
  CANCELLED_SUBSTITUTED: 'cancelled_substituted',
  REJECTED: 'rejected'
};

// cStat oficial (Anexo I, dps_field_matrix.md Seção 2.1)
export const CStat = {
  GERADA: 100,
  DECISAO_JUDICIAL_ADMINISTRATIVA: 102,
  AVULSA: 103,
  MEI: 107
};

// ambGer oficial — 1=Sistema Próprio do Município, 2=Sefin Nacional
export const AmbGer = {
  SISTEMA_PROPRIO_MUNICIPIO: 1,
  SEFIN_NACIONAL: 2
};

// tpEmis oficial — 1=emissão direta no modelo nacional, 2=leiaute próprio transcrito
export const TpEmis = {
  EMISSAO_DIRETA_NACIONAL: 1,
  LEIAUTE_PROPRIO_TRANSCRITO: 2
};

// De onde nasceu a FiscalInvoice (substitui referência direta a Payment — ver Fase 2 v3, invariante #14)
export const FiscalOriginType = {
  PACKAGE: 'package',
  APPOINTMENT: 'appointment',
  INVOICE: 'invoice',
  MANUAL: 'manual',
  BATCH: 'batch'
};

// Mecanismo oficial aplicável ao domínio `liminar` — nunca inferido automaticamente (Fase 2, Seção 6)
export const LiminarFlow = {
  NONE: 'none',
  TAX_SUSPENSION: 'tax_suspension',
  JUDICIAL_BYPASS: 'judicial_bypass'
};

export const CertificateType = {
  A1: 'A1',
  A3_HSM: 'A3_HSM'
};

export const CertificateStatus = {
  ACTIVE: 'active',
  EXPIRING_SOON: 'expiring_soon',
  EXPIRED: 'expired',
  REVOKED: 'revoked',
  VALIDATING: 'validating',
  INVALID_PASSWORD: 'invalid_password',
  CORRUPTED: 'corrupted',
  IMPORT_ERROR: 'import_error'
};

export const FiscalSubmissionOutcome = {
  // Tentativa aberta, aguardando resultado do provider (PR3 preenche outcome final)
  PENDING: 'pending',
  SUCCESS: 'success',
  REJECTED: 'rejected',
  NETWORK_ERROR: 'network_error',
  TIMEOUT: 'timeout'
};

export const FiscalAttachmentType = {
  XML_DPS: 'xml_dps',
  XML_NFSE: 'xml_nfse',
  DANFSE_PDF: 'danfse_pdf',
  XML_EVENT: 'xml_event'
};

// Mesmo enum já usado em models/ConfiguracaoFiscal.js — mantido idêntico para eventual reuso (Fase 2, Seção 0)
export const RegimeTributario = {
  SIMPLES_NACIONAL: 'SIMPLES_NACIONAL',
  LUCRO_PRESUMIDO: 'LUCRO_PRESUMIDO',
  LUCRO_REAL: 'LUCRO_REAL'
};

export const FiscalAmbiente = {
  PRODUCAO: 'producao',
  PRODUCAO_RESTRITA: 'producao_restrita'
};

// subst/cMotivo oficial (Anexo I, dps_field_matrix.md Seção 2.4) — motivo da substituição
export const SubstitutionMotivo = {
  DESENQUADRAMENTO_SIMPLES_NACIONAL: 1,
  ENQUADRAMENTO_SIMPLES_NACIONAL: 2,
  INCLUSAO_RETROATIVA_IMUNIDADE_ISENCAO: 3,
  EXCLUSAO_RETROATIVA: 4,
  REJEICAO_TOMADOR_INTERMEDIARIO: 5,
  OUTROS: 99
};

export const OfficialFiscalEventSource = {
  CRM: 'crm',
  MUNICIPIO: 'municipio',
  RECONCILIATION_WORKER: 'reconciliation_worker'
};
