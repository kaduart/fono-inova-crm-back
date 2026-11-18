// utils/ctwaContext.js
// Leitura do ctwaContext (anúncio click-to-WhatsApp da Meta) que o WhatsApp Web anexa à mensagem.
// Função pura, sem I/O.
//
// 18/11/2026: em produção o ctwaContext chega com as chaves conversionSource, conversionData,
// ctwaSignals, sourceUrl, sourceId, sourceApp, title... e SEM uma chave ctwaClid explícita.
// O código lia só ctwaRaw.ctwaClid, então o clique (ctwa_clid) nunca era salvo.
// Aqui o clid é procurado em todos os lugares conhecidos: chave direta, externalAdReply,
// ctwaSignals e conversionData (que podem vir como texto, JSON, base64 ou bytes).

// ctwa_clid não tem formato documentado; aceita id "de token" (letras, números, _ - .) com tamanho razoável.
const CLID_RE = /^[A-Za-z0-9_\-.]{10,512}$/;
const KEY_RE = /^(ctwa_?clid|clid)$/i;
const INLINE_RE = /ctwa_?clid["'\s]*[:=]["'\s]*([A-Za-z0-9_\-.]{10,512})/i;

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Bytes que passaram pelo puppeteer chegam como { "0": 12, "1": 34, ... }.
function asBytes(v) {
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) return Buffer.from(v);
  if (Array.isArray(v) && v.length && v.every((n) => Number.isInteger(n) && n >= 0 && n < 256)) return Buffer.from(v);
  if (isPlainObject(v)) {
    const keys = Object.keys(v);
    if (keys.length && keys.every((k, i) => k === String(i)) && keys.every((k) => Number.isInteger(v[k]) && v[k] >= 0 && v[k] < 256)) {
      return Buffer.from(keys.map((k) => v[k]));
    }
  }
  return null;
}

// Converte o valor em texto(s) legíveis para procurar "ctwa_clid=...": texto puro, base64 decodificado e bytes.
function textsOf(v) {
  const out = [];
  const bytes = asBytes(v);
  if (bytes) out.push(bytes.toString('utf8'));
  if (typeof v === 'string') {
    out.push(v);
    if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(v) && v.length >= 16) {
      try { out.push(Buffer.from(v, 'base64').toString('utf8')); } catch { /* não é base64 */ }
    }
  }
  return out;
}

function parseJsonSafe(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return null;
  try { return JSON.parse(t); } catch { return null; }
}

// Procura o clid num valor qualquer (objeto, texto, JSON, base64, bytes). Profundidade limitada.
function findClid(v, depth = 0) {
  if (v == null || depth > 4) return null;
  if (isPlainObject(v) && !asBytes(v)) {
    for (const [k, val] of Object.entries(v)) {
      if (KEY_RE.test(k) && typeof val === 'string' && CLID_RE.test(val)) return val;
    }
    for (const val of Object.values(v)) {
      const found = findClid(val, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const t of textsOf(v)) {
    const json = parseJsonSafe(t);
    if (json) {
      const found = findClid(json, depth + 1);
      if (found) return found;
    }
    const m = t.match(INLINE_RE);
    if (m && CLID_RE.test(m[1])) return m[1];
  }
  return null;
}

/**
 * Extrai os dados do anúncio. `raw` = msg._data.ctwaContext; `msgData` = msg._data (opcional).
 * Devolve null quando não há anúncio. `clidFrom` diz onde o clid foi achado (para o log).
 */
export function extractCtwa(raw, msgData = null) {
  const ext = msgData?.contextInfo?.externalAdReply || msgData?.externalAdReply || null;
  if (!raw && !ext) return null;
  const r = raw || {};

  const places = [
    ['ctwaContext.ctwaClid', r.ctwaClid ?? r.ctwa_clid],
    ['externalAdReply.ctwaClid', ext?.ctwaClid ?? ext?.ctwa_clid],
    ['msg.ctwaClid', msgData?.ctwaClid],
    ['ctwaSignals', r.ctwaSignals],
    ['conversionData', r.conversionData],
    ['externalAdReply', ext],
  ];
  let ctwaClid = null;
  let clidFrom = null;
  for (const [where, val] of places) {
    if (val == null) continue;
    const found = typeof val === 'string' && CLID_RE.test(val) && where.endsWith('ctwaClid') ? val : findClid(val);
    if (found) { ctwaClid = found; clidFrom = where; break; }
  }

  const sourceId = r.sourceId ?? ext?.sourceId ?? null;
  const sourceUrl = r.sourceUrl ?? ext?.sourceUrl ?? null;
  const title = r.title ?? ext?.title ?? null;
  if (!sourceId && !sourceUrl && !ctwaClid) return null;
  return {
    sourceId: sourceId ? String(sourceId) : null,
    sourceUrl: sourceUrl ? String(sourceUrl) : null,
    title: title ? String(title) : null,
    sourceApp: r.sourceApp ?? ext?.sourceApp ?? null,
    ctwaClid,
    clidFrom,
  };
}

/**
 * Descreve a ESTRUTURA do ctwaContext sem valores (nem dado pessoal): tipo e tamanho de cada chave,
 * e as chaves de objetos aninhados até 3 níveis. Para o log único de diagnóstico.
 */
export function describeCtwaShape(raw, depth = 0) {
  if (raw == null) return null;
  const bytes = asBytes(raw);
  if (bytes) return `bytes(${bytes.length})`;
  if (typeof raw === 'string') {
    const json = parseJsonSafe(raw);
    if (json && depth < 3) return { json: describeCtwaShape(json, depth + 1) };
    return `string(${raw.length})`;
  }
  if (Array.isArray(raw)) return `array(${raw.length})`;
  if (isPlainObject(raw)) {
    if (depth >= 3) return `object(${Object.keys(raw).length} chaves)`;
    const out = {};
    for (const [k, v] of Object.entries(raw)) out[k] = describeCtwaShape(v, depth + 1);
    return out;
  }
  return typeof raw;
}

export default { extractCtwa, describeCtwaShape };
