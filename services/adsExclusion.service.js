// services/adsExclusion.service.js
// Sincroniza a lista de pacientes/quem já agendou para o público de EXCLUSÃO da CA01.
// Objetivo: tirar do leilão quem já fechou (não gastar verba de aquisição com eles).
// LGPD: envia SÓ telefone, e-mail e primeiro nome (hash SHA-256). NUNCA CID/diagnóstico/coluna clínica.
//
// Env necessárias:
//   META_EXCLUSION_AUDIENCE_ID = 120250800102380554   (público "Pacientes - Exclusão (CA01)")
//   META_ADS_TOKEN             = token com permissão ads_management (NÃO é o META_CONVERSIONS_TOKEN da CAPI)
//
// Uso: updateMetaExclusionAudience(await getPacientesParaExcluir())
//   onde cada item = { phone, email?, firstName? }

import axios from 'axios';
import crypto from 'crypto';
import { normalizeE164BR } from '../utils/phone.js';

const GRAPH = 'https://graph.facebook.com/v20.0';
const BATCH = 9000; // Meta aceita ~10k usuários por chamada; folga de segurança

const sha256 = (v) => (v ? crypto.createHash('sha256').update(String(v).trim().toLowerCase()).digest('hex') : null);

// Telefone no padrão internacional (55 + DDD + número) antes do hash — igual ao metaConversionsService.
const hashPhone = (phone) => {
  if (!phone) return null;
  const e164 = normalizeE164BR(phone) || String(phone).replace(/\D/g, '');
  if (!e164) return null;
  const withDDI = e164.startsWith('55') ? e164 : `55${e164}`;
  return sha256(withDDI);
};

function buildRows(list) {
  // schema fixo: [PHONE, EMAIL, FN] — cada linha alinhada ao schema; célula ausente vai null.
  return list
    .map((p) => [hashPhone(p.phone), sha256(p.email), sha256(p.firstName)])
    .filter((row) => row[0] || row[1]); // precisa de ao menos telefone ou e-mail
}

async function postUsers(audienceId, token, rows) {
  const url = `${GRAPH}/${audienceId}/users`;
  const { data } = await axios.post(url, {
    payload: { schema: ['PHONE', 'EMAIL', 'FN'], data: rows },
  }, { params: { access_token: token } });
  return data; // { audience_id, num_received, num_invalid_entries, ... }
}

export async function updateMetaExclusionAudience(patientsList = []) {
  const audienceId = process.env.META_EXCLUSION_AUDIENCE_ID;
  const token = process.env.META_ADS_TOKEN;
  if (!audienceId || !token) {
    console.warn('[AdsExclusion] META_EXCLUSION_AUDIENCE_ID ou META_ADS_TOKEN ausente — pulando.');
    return { skipped: true };
  }

  const rows = buildRows(patientsList);
  if (!rows.length) {
    console.log('[AdsExclusion] nenhuma linha válida para enviar.');
    return { received: 0 };
  }

  let received = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    try {
      const r = await postUsers(audienceId, token, chunk);
      received += Number(r?.num_received || 0);
      console.log(`[AdsExclusion] lote ${i / BATCH + 1}: recebidos=${r?.num_received} invalidos=${r?.num_invalid_entries}`);
    } catch (err) {
      console.error('[AdsExclusion] erro no lote:', err.response?.data?.error?.message || err.message);
      throw err; // deixa o chamador decidir retry/backoff
    }
  }
  console.log(`[AdsExclusion] ✅ ${received} usuários sincronizados para exclusão.`);
  return { received };
}

export default { updateMetaExclusionAudience };
