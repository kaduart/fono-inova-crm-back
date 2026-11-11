// services/googleAdsConversionsService.js
// Upload de conversões OFFLINE (por gclid) para o Google Ads.
// Separado de services/google-ads.js de propósito: aquele lança erro no import se faltar env.
// Aqui o cliente é lazy e, sem configuração, retorna { skipped } sem quebrar nada.
// 09/11/2026: a lib 'google-ads-api' (~100 MB de heap) também é carregada só no 1º envio.

let cached = null;

async function getCustomer() {
  if (cached) return cached;
  const {
    GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_DEVELOPER_TOKEN,
    GOOGLE_ADS_REFRESH_TOKEN, GOOGLE_ADS_CUSTOMER_ID, GOOGLE_ADS_LOGIN_CUSTOMER_ID,
  } = process.env;
  if (!GOOGLE_ADS_CLIENT_ID || !GOOGLE_ADS_CLIENT_SECRET || !GOOGLE_ADS_DEVELOPER_TOKEN
    || !GOOGLE_ADS_REFRESH_TOKEN || !GOOGLE_ADS_CUSTOMER_ID) return null;

  const { GoogleAdsApi } = await import('google-ads-api');
  const client = new GoogleAdsApi({
    client_id: GOOGLE_ADS_CLIENT_ID,
    client_secret: GOOGLE_ADS_CLIENT_SECRET,
    developer_token: GOOGLE_ADS_DEVELOPER_TOKEN,
  });
  const customerId = GOOGLE_ADS_CUSTOMER_ID.replace(/\D/g, '');
  cached = {
    customerId,
    customer: client.Customer({
      customer_id: customerId,
      refresh_token: GOOGLE_ADS_REFRESH_TOKEN,
      ...(GOOGLE_ADS_LOGIN_CUSTOMER_ID && { login_customer_id: GOOGLE_ADS_LOGIN_CUSTOMER_ID.replace(/\D/g, '') }),
    }),
  };
  return cached;
}

// "yyyy-mm-dd hh:mm:ss-03:00" no fuso da clínica
function toGoogleDateTime(date) {
  const d = new Date(new Date(date).getTime() - 3 * 3600 * 1000);
  const iso = d.toISOString().replace('T', ' ').slice(0, 19);
  return `${iso}-03:00`;
}

// ─── Qual ação de conversão recebe o upload ───────────────────────────────────
// 11/11/2026: duas ações SEPARADAS no Google Ads, para não contar em dobro.
//  - 'scheduled'       → "Avaliação agendada" (GOOGLE_ADS_CONVERSION_ACTION_ID). É a MESMA ação que o
//                        feed google-offline.csv alimenta (routes/adsFeed.js). Cron + CSV usam o mesmo
//                        order_id `appt_<id>`, então o Google deduplica se os dois estiverem ligados.
//  - 'evaluation_done' → "Avaliação realizada" (GOOGLE_ADS_EVAL_DONE_ACTION_ID), ao CONCLUIR a avaliação.
//                        Sem esse env fica DESLIGADO (skipped). NUNCA cai na ação "Avaliação agendada".
// order_id com prefixo `aval-` (services/appointment/evaluationConversion.service.js) é tratado como
// 'evaluation_done' mesmo que o chamador não informe `kind` — trava contra contagem em dobro.
export const CONVERSION_KINDS = Object.freeze({
  scheduled: 'GOOGLE_ADS_CONVERSION_ACTION_ID',
  evaluation_done: 'GOOGLE_ADS_EVAL_DONE_ACTION_ID',
});

export function resolveConversionAction({ kind, orderId } = {}, env = process.env) {
  const resolvedKind = String(orderId || '').startsWith('aval-') ? 'evaluation_done' : (kind || 'scheduled');
  const envName = CONVERSION_KINDS[resolvedKind];
  if (!envName) return { kind: resolvedKind, envName: null, actionId: null };
  const actionId = String(env[envName] || '').trim() || null;
  return { kind: resolvedKind, envName, actionId };
}

/**
 * @param {{gclid:string, value?:number, currency?:string, eventTime?:Date, orderId?:string,
 *          kind?:'scheduled'|'evaluation_done'}} params
 * @returns {Promise<{status:'sent'|'skipped'|'failed', reason?:string, retryable?:boolean}>}
 */
export async function uploadOfflineConversion({ gclid, value, currency = 'BRL', eventTime, orderId, kind }) {
  if (!gclid) return { status: 'skipped', reason: 'sem_gclid' };
  const action = resolveConversionAction({ kind, orderId });
  if (!action.envName) return { status: 'skipped', reason: `tipo_de_conversao_desconhecido:${action.kind}` };
  if (!action.actionId) return { status: 'skipped', reason: `${action.envName} ausente (${action.kind} desligado)` };
  const actionId = action.actionId;
  const ctx = await getCustomer();
  if (!ctx) return { status: 'skipped', reason: 'google_ads_nao_configurado' };

  try {
    const res = await ctx.customer.conversionUploads.uploadClickConversions({
      customer_id: ctx.customerId,
      partial_failure: true,
      conversions: [{
        gclid,
        conversion_action: `customers/${ctx.customerId}/conversionActions/${actionId}`,
        conversion_date_time: toGoogleDateTime(eventTime || new Date()),
        conversion_value: Number(value) || 0,
        currency_code: currency,
        ...(orderId && { order_id: String(orderId) }), // dedup no lado do Google
      }],
    });

    const pfe = res?.partial_failure_error;
    if (pfe && (pfe.code || pfe.message)) {
      const msg = String(pfe.message || pfe.code);
      // Erros de dado (gclid inválido/expirado/duplicado) não adiantam repetir
      const permanent = /UNPARSEABLE_GCLID|EXPIRED|CLICK_NOT_FOUND|DUPLICATE|ORDER_ID_ALREADY_IN_USE|INVALID_CONVERSION_ACTION|CONVERSION_PRECEDES/i.test(msg);
      return { status: 'failed', reason: msg.slice(0, 300), retryable: !permanent };
    }
    return { status: 'sent' };
  } catch (err) {
    const msg = err?.errors?.[0]?.message || err?.message || String(err);
    return { status: 'failed', reason: String(msg).slice(0, 300), retryable: true };
  }
}

export default { uploadOfflineConversion, resolveConversionAction };
