// utils/attributionParser.js
// Extrai a ORIGEM de marketing da 1ª mensagem recebida no WhatsApp.
// Fontes (ordem de confiança):
//   1. ctwaContext do WhatsApp (anúncio click-to-WhatsApp da Meta, quando presente)
//   2. Assinatura do site: "---ref:<source>|<campaign>|<gclid|fbclid>|utm_source=<x>"
//   3. Token curto no texto pré-preenchido dos anúncios: (TK) (IG) (FB) (GG)
//   4. Palavra-chave no texto ("vi no tiktok", "instagram"...) — menor confiança
// Função pura, sem I/O — testável isoladamente.

const TOKEN_MAP = {
  TK: 'tiktok_ads',
  IG: 'instagram_ads',
  FB: 'meta_ads',
  GG: 'google_ads',
};

const KEYWORDS = [
  { re: /tik\s?tok/i, source: 'tiktok' },
  { re: /\binsta(gram)?\b/i, source: 'instagram' },
  { re: /\bfacebook\b|\bface\b/i, source: 'facebook' },
  { re: /\bgoogle\b/i, source: 'google' },
  { re: /indica(ç|c)(ã|a)o|me indicou|indicaram/i, source: 'indication' },
];

const none = (v) => (!v || v === 'none' || v === 'null' || v === 'undefined' ? null : v);

export function parseAttribution(text = '', ctwa = null) {
  const msg = String(text || '');

  // 1. Anúncio click-to-WhatsApp (Meta) — dado estruturado do próprio WhatsApp
  if (ctwa && (ctwa.sourceId || ctwa.sourceUrl || ctwa.ctwaClid)) {
    const url = String(ctwa.sourceUrl || '');
    return {
      source: /instagram/i.test(url) ? 'instagram_ads' : 'meta_ads',
      method: 'ctwa',
      confidence: 'high',
      adId: ctwa.sourceId ? String(ctwa.sourceId) : null,
      ctwaClid: ctwa.ctwaClid || null,
      // Rótulos do criativo (aparecem no card "por anúncio"); título/URL públicos do anúncio, sem dado clínico
      adTitle: ctwa.title ? String(ctwa.title).slice(0, 120) : null,
      adSourceUrl: ctwa.sourceUrl ? String(ctwa.sourceUrl).slice(0, 300) : null,
    };
  }

  // 2. Assinatura do site
  const sig = msg.match(/---ref:([^\n|]+)\|([^\n|]*)\|([^\n|]*)\|utm_source=([^\s\n]*)/i);
  if (sig) {
    const source = sig[1].trim();
    const clickId = none(sig[3].trim());
    const out = {
      source,
      method: 'site_signature',
      confidence: 'high',
      campaign: none(sig[2].trim()),
      utmSource: none(sig[4].trim()),
      gclid: null,
      fbclid: null,
    };
    if (clickId) {
      if (source === 'meta_ads') out.fbclid = clickId;
      else out.gclid = clickId; // google_ads e demais: gclid tem prioridade no site
    }
    return out;
  }

  // 3. Token curto dos anúncios
  // (TK) ou (TK-v3) / (TK:video0224): o marcador após o hífen identifica o ANÚNCIO e vira "campaign"
  const TOKEN_RE = /\((TK|IG|FB|GG)(?:[-:]([A-Za-z0-9_-]{1,40}))?\)/;
  const tok = msg.match(new RegExp(TOKEN_RE.source + '\\s*$', 'm')) || msg.match(TOKEN_RE);
  if (tok) {
    return { source: TOKEN_MAP[tok[1]], method: 'token', confidence: 'high', campaign: tok[2] || null };
  }

  // 4. Palavra-chave
  for (const k of KEYWORDS) {
    if (k.re.test(msg)) return { source: k.source, method: 'keyword', confidence: 'low' };
  }

  return null;
}

// Converte o source granular para o enum já existente em Lead.metaTracking.source
export function toLeadTrackingSource(source) {
  const map = {
    meta_ads: 'meta_ads',
    instagram_ads: 'meta_ads',
    google_ads: 'google_ads',
    tiktok_ads: 'tiktok_ads',
    tiktok: 'tiktok_ads',
    instagram: 'instagram',
    instagram_organic: 'instagram',
    facebook: 'facebook',
    facebook_organic: 'facebook',
    google_organic: 'organic',
    gmb: 'organic',
    google: 'organic',
    indication: 'indication',
  };
  return map[source] || 'website';
}

export default { parseAttribution, toLeadTrackingSource };
