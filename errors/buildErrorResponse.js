/**
 * buildErrorResponse — ÚNICO lugar que decide o formato de erro da API.
 *
 * Envelope (superconjunto do que já existia — nada que o front lê hoje deixa de existir):
 *
 *   {
 *     success: false,
 *     code:    'PAYMENT_STATUS_NOT_BILLABLE',   // estável, para o front decidir comportamento
 *     message: '…texto para o usuário…',        // pt-BR, completo (título + fato + o que fazer)
 *     error:   '…mesmo texto…',                 // compatibilidade: o front antigo lê `error`
 *     title?, action?, items?,                  // para UI rica
 *     details?,                                 // dados estruturados (ids) — técnicos
 *     technicalMessage?,                        // texto técnico original, p/ suporte
 *     errors?,                                  // validação: [{ field, message }]
 *     correlationId?
 *   }
 *
 * Função sem I/O de resposta — testável. `sendApiError` faz o envio + log.
 */
import { getCatalogEntry, runHumanizer } from './errorCatalog.js';

// Campos do envelope — `extra` de um erro nunca os sobrescreve.
const RESERVED_KEYS = new Set(['success', 'code', 'errorCode', 'message', 'error', 'title', 'action', 'items', 'details', 'technicalMessage', 'correlationId', 'stack']);

const SYSTEM_CODE = /^E[A-Z0-9_]+$/; // ECONNRESET, ETIMEDOUT… — nunca expor ao usuário como código de negócio

function resolveStatus(error, catalogEntry) {
  const explicit = error?.status ?? error?.statusCode;
  if (Number.isInteger(explicit) && explicit >= 400 && explicit < 600) return explicit;
  if (error?.name === 'ValidationError' || error?.name === 'CastError') return 400;
  if (error?.code === 11000) return 409;
  if (typeof error?.name === 'string' && error.name.endsWith('InvariantError')) return 409;
  if (catalogEntry?.status) return catalogEntry.status;
  return 500;
}

function resolveCode(error) {
  if (error?.name === 'ValidationError') return 'VALIDATION_ERROR';
  if (error?.name === 'CastError') return 'INVALID_ID';
  if (error?.code === 11000) return 'DUPLICATE_KEY';
  if (typeof error?.code === 'string' && !SYSTEM_CODE.test(error.code)) return error.code;
  return 'INTERNAL_ERROR';
}

function validationItems(error) {
  if (error?.name !== 'ValidationError' || !error.errors) return null;
  return Object.values(error.errors).map((e) => ({ field: e.path, message: e.message }));
}

/**
 * @returns {Promise<{ status:number, body:object }>}
 */
export async function buildErrorResponse(error, { correlationId, includeStack = false } = {}) {
  const code = resolveCode(error);
  const catalogEntry = getCatalogEntry(code);
  const status = resolveStatus(error, catalogEntry);

  const technicalMessage = error?.message || 'Erro interno do servidor';
  const human = status === 500 ? null : await runHumanizer(error);
  const validation = validationItems(error);

  let title = human?.title ?? error?.title ?? catalogEntry?.title;
  let action = human?.action ?? error?.action ?? catalogEntry?.action;
  let message = human?.message ?? technicalMessage;

  if (validation) {
    message = `Dados inválidos: ${validation.map((v) => v.message).join('; ')}`;
  } else if (!human && !error?.isAppError && (error?.title || catalogEntry?.title || action)) {
    // Sem tradutor e sem mensagem explícita (AppError): monta texto a partir do que o erro/catálogo declara.
    message = [title, technicalMessage !== title ? technicalMessage : null, action].filter(Boolean).join('\n');
  }

  const items = human?.items ?? error?.items;
  const extra = Object.fromEntries(
    Object.entries(error?.extra || {}).filter(([key]) => !RESERVED_KEYS.has(key))
  );
  const body = {
    ...extra,
    success: false,
    code,
    errorCode: code, // alias: parte do front e do app agenda lê `errorCode`
    message,
    // compatibilidade: consumidores antigos leem `error` (texto curto original, quando havia)
    error: !human && typeof error?.legacyError === 'string' ? error.legacyError : message,
    ...(title ? { title } : {}),
    ...(action ? { action } : {}),
    ...(items ? { items } : {}),
    ...(validation ? { errors: validation } : {}),
    ...(error?.details !== undefined ? { details: error.details } : {}),
    ...(technicalMessage && technicalMessage !== message ? { technicalMessage } : {}),
    ...(correlationId && !('correlationId' in extra) ? { correlationId } : {}),
    ...(includeStack && error?.stack ? { stack: error.stack } : {}),
  };
  return { status, body };
}

/** Envia a resposta de erro padrão e registra no log (5xx = error, demais = warn). */
export async function sendApiError(res, error, req = null) {
  const correlationId = req?.headers?.['x-correlation-id'] || req?.correlationId;
  const { status, body } = await buildErrorResponse(error, {
    correlationId,
    includeStack: process.env.NODE_ENV === 'development',
  });
  if (status >= 500) console.error('[API_ERROR]', { code: body.code, url: req?.originalUrl, error });
  else console.warn('[API_ERROR]', body.code, '-', body.technicalMessage || body.message);
  if (res.headersSent) return;
  return res.status(status).json(body);
}

export default { buildErrorResponse, sendApiError };
