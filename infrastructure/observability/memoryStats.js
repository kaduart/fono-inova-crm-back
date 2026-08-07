// infrastructure/observability/memoryStats.js
/**
 * Fonte única de verdade para métricas de memória do processo.
 *
 * Dois tetos diferentes, e confundir os dois é a origem dos falsos alarmes:
 *
 *  1. HEAP (V8)      — `heap_size_limit`. NÃO usar `heapTotal` como denominador:
 *                      heapTotal é o que o V8 já alocou, não o teto, e fica colado
 *                      no heapUsed depois de cada GC. Por isso "97%" era saudável.
 *
 *  2. RSS (container) — a RAM que o Render/Docker realmente concede. É este que
 *                      mata o processo (OOM kill). No plano Starter são 512MB,
 *                      MUITO abaixo do heap limit do V8 — então o RSS estoura primeiro.
 *
 * O limite de RSS é detectado em cascata: MEMORY_LIMIT_MB > cgroup > os.totalmem().
 * O valor detectado é logado no boot (logMemoryLimits) para conferência em produção.
 *
 * Sem dependências externas. Seguro para importar de workers e entrypoints.
 */

import v8 from 'node:v8';
import os from 'node:os';
import fs from 'node:fs';

const toMB = (v) => Math.round(v / 1024 / 1024);

// heap_size_limit não muda em runtime — lido uma vez.
const HEAP_LIMIT_BYTES = v8.getHeapStatistics().heap_size_limit;

// ============================================
// DETECÇÃO DO LIMITE DE RSS (container)
// ============================================

function readCgroupLimitMB() {
  const candidates = [
    '/sys/fs/cgroup/memory.max',                  // cgroup v2
    '/sys/fs/cgroup/memory/memory.limit_in_bytes' // cgroup v1
  ];

  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, 'utf8').trim();
      if (raw === 'max') continue;               // v2 sem limite
      const bytes = Number(raw);
      if (!Number.isFinite(bytes) || bytes <= 0) continue;
      const mb = toMB(bytes);
      // cgroup v1 usa um número gigante para "sem limite"; e um limite maior que a
      // RAM da máquina não é limite de container de verdade.
      if (mb <= 0 || mb > toMB(os.totalmem())) continue;
      return { limitMB: mb, source: file.includes('memory.max') ? 'cgroup-v2' : 'cgroup-v1' };
    } catch {
      // arquivo ausente (host comum, WSL2, macOS) — segue para o próximo
    }
  }
  return null;
}

function detectRssLimit() {
  const envMB = parseInt(process.env.MEMORY_LIMIT_MB || '', 10);
  if (Number.isFinite(envMB) && envMB > 0) {
    return { limitMB: envMB, source: 'MEMORY_LIMIT_MB' };
  }

  const cgroup = readCgroupLimitMB();
  if (cgroup) return cgroup;

  // Último recurso: RAM da máquina. Em container isto pode reportar a RAM do HOST
  // (bem maior que a cota real) — daí a importância de setar MEMORY_LIMIT_MB.
  return { limitMB: toMB(os.totalmem()), source: 'os.totalmem (fallback)' };
}

const { limitMB: RSS_LIMIT_MB, source: RSS_LIMIT_SOURCE } = detectRssLimit();

// ============================================
// THRESHOLDS (percentuais do limite detectado)
// ============================================

const pct = (envVar, fallback) => {
  const v = parseFloat(process.env[envVar] || '');
  return Number.isFinite(v) && v > 0 && v <= 100 ? v : fallback;
};

const RSS_WARN_PERCENT  = pct('MEMORY_WARN_PERCENT', 80);
const RSS_CRIT_PERCENT  = pct('MEMORY_CRIT_PERCENT', 92);
const HEAP_WARN_PERCENT = 75;
const HEAP_CRIT_PERCENT = 90;

const RSS_WARN_MB = Math.round(RSS_LIMIT_MB * RSS_WARN_PERCENT / 100);
const RSS_CRIT_MB = Math.round(RSS_LIMIT_MB * RSS_CRIT_PERCENT / 100);

/**
 * Snapshot de memória. `heapPercent` mede contra o teto do V8;
 * `rssPercent` mede contra a cota do container — este é o que causa OOM kill.
 *
 * @returns {{
 *   heapUsedMB: number, heapTotalMB: number, heapLimitMB: number, heapPercent: number,
 *   rssMB: number, rssLimitMB: number, rssPercent: number, externalMB: number,
 *   status: 'healthy'|'warning'|'critical'
 * }}
 */
export function getMemorySnapshot() {
  const mem = process.memoryUsage();
  const rssMB = toMB(mem.rss);

  const heapPercent = parseFloat(((mem.heapUsed / HEAP_LIMIT_BYTES) * 100).toFixed(1));
  const rssPercent = parseFloat(((rssMB / RSS_LIMIT_MB) * 100).toFixed(1));

  const status =
    (rssMB >= RSS_CRIT_MB || heapPercent >= HEAP_CRIT_PERCENT) ? 'critical' :
    (rssMB >= RSS_WARN_MB || heapPercent >= HEAP_WARN_PERCENT) ? 'warning' :
    'healthy';

  return {
    heapUsedMB: toMB(mem.heapUsed),
    heapTotalMB: toMB(mem.heapTotal),
    heapLimitMB: toMB(HEAP_LIMIT_BYTES),
    heapPercent,
    rssMB,
    rssLimitMB: RSS_LIMIT_MB,
    rssPercent,
    externalMB: toMB(mem.external),
    status
  };
}

/**
 * Loga os tetos detectados. Chamar uma vez no boot — em produção é a única
 * forma de confirmar QUAL fonte o container usou (cgroup vs env vs fallback).
 */
export function logMemoryLimits(prefix = '[Memory]') {
  console.log(
    `${prefix} rss limit=${RSS_LIMIT_MB}MB (fonte: ${RSS_LIMIT_SOURCE}) ` +
    `warn>=${RSS_WARN_MB}MB crit>=${RSS_CRIT_MB}MB | heap limit=${toMB(HEAP_LIMIT_BYTES)}MB`
  );
  if (RSS_LIMIT_SOURCE.startsWith('os.totalmem')) {
    console.warn(
      `${prefix} ⚠️  Limite de RSS não detectado por cgroup. Em container (Render), ` +
      `defina MEMORY_LIMIT_MB com a cota do plano (Starter = 512) ou os alertas não vão disparar.`
    );
  }
}

export const HEAP_LIMIT_MB = toMB(HEAP_LIMIT_BYTES);
export const RSS_LIMIT_INFO = { limitMB: RSS_LIMIT_MB, source: RSS_LIMIT_SOURCE, warnMB: RSS_WARN_MB, critMB: RSS_CRIT_MB };
