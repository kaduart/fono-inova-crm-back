// services/tiktokConversionsService.js
// Envia conversões server-side para a TikTok Events API (v1.3).
// Espelha metaConversionsService: hash de telefone, event_id p/ dedupe, nunca dado clínico.
//
// Env:
//   TIKTOK_EVENTS_TOKEN   Access Token da Events API (Events Manager > pixel > Settings)
//   TIKTOK_PIXEL_ID       (opcional) codigo do pixel; default: DB3PQARC77UA626EKV60

import axios from "axios";
import crypto from "crypto";
import { normalizeE164BR } from "../utils/phone.js";

const ENDPOINT = "https://business-api.tiktok.com/open_api/v1.3/event/track/";
const DEFAULT_PIXEL = "DB3PQARC77UA626EKV60";

function hashPhoneE164(phone) {
  if (!phone) return null;
  const digits = normalizeE164BR(phone) || String(phone).replace(/\D/g, "");
  if (!digits) return null;
  const e164 = String(digits).startsWith("+") ? digits : `+${digits}`;
  return crypto.createHash("sha256").update(e164).digest("hex");
}

/**
 * Envia um evento para a TikTok Events API.
 * Retorna a resposta (code:0) em sucesso, ou null quando nao configurado / sem identificador.
 * Lanca erro em falha de rede/HTTP ou code != 0 (p/ o cron tratar retry).
 */
export async function sendEventToTikTok({
  eventName = "Schedule", // agendou = Schedule (evento padrao do TikTok; match semantico exato com Meta Schedule)
  phone,
  ttclid,
  value,
  currency = "BRL",
  eventId,
  eventTime,
  customData = {},
}) {
  const token = (process.env.TIKTOK_EVENTS_TOKEN || "").trim();
  const pixel = (process.env.TIKTOK_PIXEL_ID || DEFAULT_PIXEL).trim();
  if (!token) {
    console.warn("⚠️ TikTok Events API nao configurado (TIKTOK_EVENTS_TOKEN ausente)");
    return null;
  }

  const user = {};
  const ph = hashPhoneE164(phone);
  if (ph) user.phone = ph;
  if (ttclid) user.ttclid = ttclid;
  if (!user.phone && !user.ttclid) {
    console.warn("⚠️ TikTok: evento sem telefone nem ttclid, ignorado");
    return null;
  }

  const properties = { ...customData };
  if (value != null) properties.value = Number(value);
  if (currency) properties.currency = currency;

  const body = {
    event_source: "web",
    event_source_id: pixel,
    data: [{
      event: eventName,
      event_time: Math.floor((eventTime ? new Date(eventTime).getTime() : Date.now()) / 1000),
      ...(eventId && { event_id: String(eventId) }),
      user,
      properties,
      page: { url: "https://clinicafonoinova.com.br" },
    }],
  };

  const resp = await axios.post(ENDPOINT, body, {
    headers: { "Access-Token": token, "Content-Type": "application/json" },
    timeout: 15000,
  });

  const data = resp.data || {};
  if (data.code !== 0) {
    const e = new Error(`TikTok Events code=${data.code} msg=${data.message}`);
    e.response = { data };
    throw e;
  }
  console.log(`✅ TikTok Events: ${eventName} enviado (req ${data.request_id || "?"})`);
  return data;
}

export default { sendEventToTikTok };
