/**
 * Decision Metrics Service v2 — Persistência MongoDB + Buffer em memória
 *
 * - recordDecision() → grava no buffer (síncrono) + MongoDB (async fire-and-forget)
 * - getSnapshot()    → consulta MongoDB para janela histórica; fallback para buffer
 *
 * Resolve o problema do buffer zerando a cada restart do servidor (Render ~50min).
 */

import DecisionMetric from '../../models/DecisionMetric.js';

const MAX_ENTRIES = 1000;
const buffer = [];

// ─── Escrita ──────────────────────────────────────────────────────────────────

/**
 * Registra uma decisão.
 * Síncrono no buffer, assíncrono no MongoDB.
 */
export function recordDecision({ action, domain, confidence, activeFlags, latencyMs, orchestrator }) {
  const entry = {
    ts:          new Date(),
    action:      action || 'unknown',
    domain:      domain || null,
    confidence:  confidence ?? null,
    flags:       Array.isArray(activeFlags) ? activeFlags : [],
    latencyMs:   latencyMs ?? null,
    orchestrator: orchestrator || null,
  };

  // Buffer circular em memória (rápido, sem await)
  if (buffer.length >= MAX_ENTRIES) buffer.shift();
  buffer.push({ ...entry, ts: entry.ts.getTime() });

  // Persistência no MongoDB (fire-and-forget — não bloqueia o orchestrator)
  DecisionMetric.create(entry).catch(err => {
    // Silencioso: não deixa falha de métricas afetar o fluxo principal
    console.warn('[DecisionMetrics] Falha ao gravar no MongoDB:', err.message);
  });
}

// ─── Leitura / Snapshot ───────────────────────────────────────────────────────

/**
 * Retorna snapshot agregado.
 *
 * Estratégia:
 *   1. Consulta MongoDB (tem histórico mesmo após restart)
 *   2. Se MongoDB não responder, usa buffer em memória
 *
 * @param {Object} opts
 * @param {number} [opts.last]          — últimas N decisões (default 500)
 * @param {number} [opts.windowMinutes] — janela em minutos (alternativa ao `last`)
 */
export async function getSnapshot({ last, windowMinutes } = {}) {
  try {
    const entries = await _queryMongo({ last, windowMinutes });
    if (entries.length > 0) return _aggregate(entries);
  } catch (err) {
    console.warn('[DecisionMetrics] MongoDB indisponível, usando buffer:', err.message);
  }

  // Fallback para buffer em memória
  return _aggregate(_bufferEntries({ last, windowMinutes }));
}

// ─── Helpers internos ─────────────────────────────────────────────────────────

async function _queryMongo({ last, windowMinutes }) {
  const query = {};

  if (windowMinutes) {
    query.ts = { $gte: new Date(Date.now() - windowMinutes * 60 * 1000) };
  }

  const limit = last ? Math.min(last, MAX_ENTRIES) : 500;

  const docs = await DecisionMetric.find(query)
    .sort({ ts: -1 })
    .limit(limit)
    .lean();

  // Retorna do mais antigo para o mais novo (para cálculos de percentil)
  return docs.reverse().map(d => ({
    ts:        new Date(d.ts).getTime(),
    action:    d.action,
    domain:    d.domain,
    confidence:d.confidence,
    flags:     d.flags,
    latencyMs: d.latencyMs,
  }));
}

function _bufferEntries({ last, windowMinutes }) {
  let entries = buffer.slice();
  if (windowMinutes) {
    const cutoff = Date.now() - windowMinutes * 60 * 1000;
    entries = entries.filter(e => e.ts >= cutoff);
  } else if (last) {
    entries = entries.slice(-Math.min(last, MAX_ENTRIES));
  } else {
    entries = entries.slice(-500);
  }
  return entries;
}

function _aggregate(entries) {
  const total = entries.length;

  if (total === 0) {
    return {
      total: 0, actions: {}, domains: {}, topFlags: [],
      latency: null, latencyByAction: {}, alerts: [],
      bufferSize: buffer.length, source: 'empty',
    };
  }

  // Actions
  const actionCounts = { RULE: 0, HYBRID: 0, AI: 0, unknown: 0 };
  for (const e of entries) {
    const k = e.action in actionCounts ? e.action : 'unknown';
    actionCounts[k]++;
  }
  const actions = {};
  for (const [k, v] of Object.entries(actionCounts)) {
    if (v > 0) actions[k] = { count: v, pct: pct(v, total) };
  }

  // Domains
  const domainCounts = {};
  for (const e of entries) {
    const d = e.domain || 'null';
    domainCounts[d] = (domainCounts[d] || 0) + 1;
  }
  const domains = Object.fromEntries(
    Object.entries(domainCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => [k, { count: v, pct: pct(v, total) }])
  );

  // Top flags
  const flagCounts = {};
  for (const e of entries) {
    for (const f of e.flags ?? []) {
      flagCounts[f] = (flagCounts[f] || 0) + 1;
    }
  }
  const topFlags = Object.entries(flagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([flag, count]) => ({ flag, count, pct: pct(count, total) }));

  // Latência global
  const latencies = entries.map(e => e.latencyMs).filter(v => v != null);
  const latency = latencies.length > 0 ? {
    avg: avg(latencies),
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: Math.max(...latencies),
  } : null;

  // Latência por action
  const latencyByAction = {};
  for (const action of ['RULE', 'HYBRID', 'AI']) {
    const vals = entries
      .filter(e => e.action === action && e.latencyMs != null)
      .map(e => e.latencyMs);
    if (vals.length > 0) {
      latencyByAction[action] = { avg: avg(vals), p95: percentile(vals, 95) };
    }
  }

  // Alertas automáticos
  const alerts = [];
  const hybridPct = (actionCounts.HYBRID / total) * 100;
  const aiPct     = (actionCounts.AI / total) * 100;

  if (hybridPct > 40) {
    alerts.push({ level: 'warning', code: 'HIGH_HYBRID',
      message: `HYBRID em ${hybridPct.toFixed(1)}% — regras podem estar fracas` });
  }
  if (aiPct > 50) {
    alerts.push({ level: 'warning', code: 'HIGH_AI',
      message: `AI em ${aiPct.toFixed(1)}% — sistema pouco determinístico` });
  }
  if (latency && latency.p95 > 500) {
    alerts.push({ level: 'warning', code: 'HIGH_LATENCY',
      message: `p95 de latência em ${latency.p95}ms — investigar` });
  }

  return {
    total,
    actions, domains, topFlags,
    latency, latencyByAction, alerts,
    bufferSize: buffer.length,
    source: 'mongodb',
  };
}

// ─── Utils ────────────────────────────────────────────────────────────────────

function pct(v, total) {
  return total > 0 ? parseFloat((v / total * 100).toFixed(1)) : 0;
}
function avg(arr) {
  return parseFloat((arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(2));
}
function percentile(arr, p) {
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

/** Limpa buffer (útil em testes) */
export function resetMetrics() {
  buffer.length = 0;
}
