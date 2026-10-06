/**
 * AppError — erro de negócio com contexto para o usuário.
 *
 * Use quando a regra de negócio recusa uma ação e a pessoa precisa entender por quê:
 *
 *   throw new AppError('APPOINTMENT_SLOT_TAKEN', 'Horário já ocupado', {
 *     status: 409,
 *     title: 'Horário indisponível',
 *     action: 'Escolha outro horário.',
 *     details: { sessionIds: [...] },   // dados para o tradutor do domínio identificar paciente/sessão
 *   });
 *
 * O errorHandler global (middleware/errorHandler.js) converte em resposta padrão — ver
 * docs/MENSAGERIA_PADRAO.md. Erros de domínio antigos (BillingSubmissionError etc.) continuam
 * funcionando: basta terem `code` e `status`.
 */
export class AppError extends Error {
  /**
   * @param {string} code  Código estável em MAIÚSCULAS (ex.: PAYMENT_STATUS_NOT_BILLABLE).
   * @param {string} message  Texto técnico/resumo. O tradutor do domínio pode trocá-lo por um texto para o usuário.
   * @param {{status?:number,title?:string,action?:string,items?:any[],details?:any,cause?:Error,
   *          extra?:Record<string,any>,legacyError?:string}} [options]
   *   extra: campos de topo que consumidores antigos já leem (ex.: correlationId, conflict, suggestion) —
   *          não sobrescrevem os campos do envelope. legacyError: texto curto antigo de `error`, quando
   *          diferia de `message`.
   */
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.isAppError = true;
    this.code = code;
    this.status = options.status ?? 400;
    if (options.title) this.title = options.title;
    if (options.action) this.action = options.action;
    if (options.items) this.items = options.items;
    if (options.details !== undefined) this.details = options.details;
    if (options.cause) this.cause = options.cause;
    if (options.extra) this.extra = options.extra;
    if (options.legacyError) this.legacyError = options.legacyError;
  }
}

export default AppError;
