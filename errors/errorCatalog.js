/**
 * Catálogo central de erros + registro de tradutores por domínio.
 *
 * Dois níveis, do mais específico ao mais genérico:
 *
 *  1. TRADUTOR (humanizer): função async que recebe o erro e devolve
 *     { message, title?, action?, items? } já em linguagem para o usuário, normalmente
 *     identificando paciente/sessão/guia. Registrado por domínio (ex.: faturamento).
 *  2. CATÁLOGO: por `code`, define status HTTP padrão, título e ação padrão. Serve para
 *     códigos que não precisam de contexto.
 *
 * Regra de ouro: o texto técnico original NUNCA se perde — vai em `technicalMessage`.
 */

const CATALOG = new Map();
const HUMANIZERS = [];

/** @param {Record<string,{status?:number,title?:string,message?:string,action?:string}>} entries */
export function registerErrorCatalog(entries) {
  for (const [code, entry] of Object.entries(entries)) CATALOG.set(code, Object.freeze({ ...entry }));
}

export function getCatalogEntry(code) {
  return code ? CATALOG.get(code) || null : null;
}

/**
 * @param {(code:string)=>boolean} match  decide se o tradutor atende o código
 * @param {(error:any)=>Promise<null|{message:string,title?:string,action?:string,items?:any[]}>} fn
 */
export function registerHumanizer(match, fn) {
  HUMANIZERS.push({ match, fn });
}

export async function runHumanizer(error) {
  const code = error?.code;
  if (typeof code !== 'string') return null;
  const humanizer = HUMANIZERS.find((h) => {
    try { return h.match(code); } catch { return false; }
  });
  if (!humanizer) return null;
  try {
    return (await humanizer.fn(error)) || null;
  } catch {
    return null; // tradutor nunca pode derrubar a resposta de erro
  }
}

// ── Códigos genéricos já documentados em API_CONTRACT_V2.md ──────────────────
registerErrorCatalog({
  UNAUTHORIZED: { status: 401, title: 'Sessão expirada', action: 'Entre novamente no sistema.' },
  FORBIDDEN: { status: 403, title: 'Sem permissão', action: 'Peça a um administrador para liberar esta ação.' },
  NOT_FOUND: { status: 404, title: 'Não encontrado' },
  DUPLICATE_APPOINTMENT: { status: 409, title: 'Horário já ocupado', action: 'Escolha outro horário.' },
  CONFLICT_STATE: { status: 409, title: 'A situação mudou', action: 'Atualize a tela e confira antes de repetir.' },
  MISSING_REQUIRED_FIELDS: { status: 400, title: 'Faltam campos obrigatórios' },
  VALIDATION_ERROR: { status: 400, title: 'Dados inválidos' },
  INVALID_ID: { status: 400, title: 'Identificador inválido' },
  DUPLICATE_KEY: { status: 409, title: 'Registro já existe' },
  INSURANCE_GUIDE_REQUIRED: { status: 400, title: 'Guia de convênio obrigatória', action: 'Cadastre ou selecione a guia do paciente.' },
  // Invariantes financeiras: estado de negócio, não erro interno.
  CONVENIO_PAID_REQUIRES_INSURANCE_RECEIPT: {
    status: 409,
    title: 'Convênio só é pago pelo recebimento do convênio',
    action: 'Registre o recebimento pela baixa do convênio, não como pagamento comum.',
  },
  PAYMENT_STATUS_NOT_BILLABLE: { status: 409 },
  PAYMENT_BILLING_TYPE_INVALID: { status: 409 },
  PAYMENT_IS_PACKAGE_CONSUMPTION: { status: 409 },
  PAYMENT_KIND_UNKNOWN: { status: 409 },
});

export default { registerErrorCatalog, getCatalogEntry, registerHumanizer, runHumanizer };
