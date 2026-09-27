// services/googleAdsConversionsService.js
// Upload de conversões OFFLINE (por gclid) para o Google Ads.
// Separado de services/google-ads.js de propósito: aquele lança erro no import se faltar env.
// Aqui o cliente é lazy e, sem configuração, retorna { skipped } sem quebrar nada.
import { GoogleAdsApi } from 'google-ads-api';

let cached = null;

function getCustomer() {
  if (cached) return cached;
  const {
    GOOGLE_ADS_CLIENT_ID, GOOGLE_ADS_CLIENT_SECRET, GOOGLE_ADS_DEVELOPER_TOKEN,
    GOOGLE_ADS_REFRESH_TOKEN, GOOGLE_ADS_CUSTOMER_ID, GOOGLE_ADS_LOGIN_CUSTOMER_ID,
  } = process.env;
  if (!GOOGLE_ADS_CLIENT_ID || !GOOGLE_ADS_CLIENT_SECRET || !GOOGLE_ADS_DEVELOPER_TOKEN
    || !GOOGLE_ADS_REFRESH_TOKEN || !GOOGLE_ADS_CUSTOMER_ID) return null;

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

/**
 * @returns {Promise<{status:'sent'|'skipped'|'failed', reason?:string, retryable?:boolean}>}
 */
export async function uploadOfflineConversion({ gclid, value, currency = 'BRL', eventTime, orderId }) {
  if (!gclid) return { status: 'skipped', reason: 'sem_gclid' };
  const actionId = process.env.GOOGLE_ADS_CONVERSION_ACTION_ID;
  if (!actionId) return { status: 'skipped', reason: 'GOOGLE_ADS_CONVERSION_ACTION_ID ausente' };
  const ctx = getCustomer();
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

export default { uploadOfflineConversion };
