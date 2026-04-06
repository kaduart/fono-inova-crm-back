/**
 * Decision Metrics Service — Agregação em memória das decisões do DecisionResolver
 *
 * Circular buffer de 1000 entradas. Sem dependência de banco ou Redis.
 * Expõe getSnapshot() para o endpoint de métricas.
 */

const MAX_ENTRIES = 1000;

/** @type {Array<Object>} */
const buffer = [];

/**
 * Registra uma decisão no buffer circular.
 * Chamado pelo decisionLogger automaticamente.
 */
export function recordDecision({ action, domain, confidence, activeFlags, latencyMs }) {
  if (buffer.length >= MAX_ENTRIES) buffer.shift();

  buffer.push({
    ts: Date.now(),
    action:     action || 'unknown',
    domain:     domain || null,
    confidence: confidence ?? null,
    flags:      Array.isArray(activeFlags) ? activeFlags : [],
    latencyMs:  latencyMs ?? null,
  });
}

/**
 * Retorna snapshot agregado das últimas N decisões (default: 500).
 *
 * @param {Object} opts
 * @param {number} [opts.last]        — quantas entradas considerar (max MAX_ENTRIES)
 * @param {number} [opts.windowMinutes] — janela de tempo em minutos (alternativa ao `last`)
 * @returns {Object}
 */
export function getSnapshot({ last, windowMinutes } = {}) {
  let entries = buffer.slice();

  if (windowMinutes) {
    const cutoff = Date.now() - windowMinutes * 60 * 1000;
    entries = entries.filter(e => e.ts >= cutoff);
  } else if (last) {
    entries = entries.slice(-Math.min(last, MAX_ENTRIES));
  } else {
    entries = entries.slice(-500);
  }

  const total = entries.length;
  if (total === 0) {
    return { total: 0, actions: {}, domains: {}, topFlags: [], latency: null, alerts: [] };
  }

  // ── Contagem de actions ──────────────────────────────────────────────────
  const actionCounts = { RULE: 0, HYBRID: 0, AI: 0, unknown: 0 };
  for (const e of entries) {
    const k = e.action in actionCounts ? e.action : 'unknown';
    actionCounts[k]++;
  }
  const actions = {};
  for (const [k, v] of Object.entries(actionCounts)) {
    if (v > 0) actions[k] = { count: v, pct: pct(v, total) };
  }

  // ── Contagem de domains ──────────────────────────────────────────────────
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

  // ── Top flags ────────────────────────────────────────────────────────────
  const flagCounts = {};
  for (const e of entries) {
    for (const f of e.flags) {
      flagCounts[f] = (flagCounts[f] || 0) + 1;
    }
  }
  const topFlags = Object.entries(flagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([flag, count]) => ({ flag, count, pct: pct(count, total) }));

  // ── Latência ─────────────────────────────────────────────────────────────
  const latencies = entries.map(e => e.latencyMs).filter(v => v != null);
  const latency = latencies.length > 0 ? {
    avg:  avg(latencies),
    p50:  percentile(latencies, 50),
    p95:  percentile(latencies, 95),
    p99:  percentile(latencies, 99),
    max:  Math.max(...latencies),
  } : null;

  // ── Latência por action ──────────────────────────────────────────────────
  const latencyByAction = {};
  for (const action of ['RULE', 'HYBRID', 'AI']) {
    const vals = entries
      .filter(e => e.action === action && e.latencyMs != null)
      .map(e => e.latencyMs);
    if (vals.length > 0) {
      latencyByAction[action] = { avg: avg(vals), p95: percentile(vals, 95) };
    }
  }

  // ── Alertas automáticos ──────────────────────────────────────────────────
  const alerts = [];
  const hybridPct = (actionCounts.HYBRID / total) * 100;
  const aiPct     = (actionCounts.AI / total) * 100;

  if (hybridPct > 40) {
    alerts.push({
      level: 'warning',
      code: 'HIGH_HYBRID',
      message: `HYBRID em ${hybridPct.toFixed(1)}% — regras podem estar fracas`,
    });
  }
  if (aiPct > 50) {
    alerts.push({
      level: 'warning',
      code: 'HIGH_AI',
      message: `AI em ${aiPct.toFixed(1)}% — sistema pouco determinístico`,
    });
  }
  if (latency && latency.p95 > 500) {
    alerts.push({
      level: 'warning',
      code: 'HIGH_LATENCY',
      message: `p95 de latência em ${latency.p95}ms — investigar`,
    });
  }

  return {
    total,
    window: windowMinutes ? `${windowMinutes}m` : `last ${entries.length}`,
    actions,
    domains,
    topFlags,
    latency,
    latencyByAction,
    alerts,
    bufferSize: buffer.length,
  };
}

/** Limpa o buffer (útil em testes) */
export function resetMetrics() {
  buffer.length = 0;
}

// ── helpers ──────────────────────────────────────────────────────────────────

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
