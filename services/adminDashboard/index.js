/**
 * 🚀 Admin Dashboard V2 — Orchestrator
 *
 * Coordena os builders com cache granular e query modular.
 */

import { dashboardCache } from '../adminDashboardCacheService.js';
import { buildStats } from './statsBuilder.js';
import { buildCharts } from './chartsBuilder.js';
import { buildDoctorsOverview } from './doctorsOverviewBuilder.js';
import { buildUpcomingAppointments } from './upcomingBuilder.js';

const BLOCKS = {
  stats:    { builder: buildStats,                           ttl: 120, cacheKey: 'v2:stats' },
  charts:   { builder: buildCharts,                          ttl: 300, cacheKey: 'v2:charts' },
  doctors:  { builder: () => buildDoctorsOverview(10),       ttl: 120, cacheKey: 'v2:doctors' },
  upcoming: { builder: () => buildUpcomingAppointments(10),  ttl: 60,  cacheKey: 'v2:upcoming' }
};

/**
 * Constrói o overview do dashboard V2
 *
 * @param {string[]} include — blocos solicitados (default: todos)
 * @param {boolean} forceRefresh — ignorar cache
 */
export async function buildDashboardOverview(include = Object.keys(BLOCKS), forceRefresh = false) {
  const validBlocks = include.filter(b => BLOCKS[b]);

  const results = await Promise.all(
    validBlocks.map(async blockName => {
      const config = BLOCKS[blockName];

      if (forceRefresh) {
        await dashboardCache.invalidate(config.cacheKey);
      }

      const data = await dashboardCache.getOrSet(
        config.cacheKey,
        config.builder,
        config.ttl
      );

      // Remove metadados internos de cache antes de retornar
      // ⚠️ Preserva arrays — { ...array } cria objeto!
      let clean;
      if (Array.isArray(data)) {
        clean = data.map(item => {
          if (item && typeof item === 'object') {
            const copy = { ...item };
            delete copy._cachedAt;
            delete copy._incrementalUpdate;
            return copy;
          }
          return item;
        });
      } else {
        clean = { ...data };
        delete clean._cachedAt;
        delete clean._incrementalUpdate;
      }

      return { block: blockName, data: clean };
    })
  );

  const response = {
    meta: {
      generatedAt: new Date().toISOString(),
      version: 'v2',
      included: validBlocks
    }
  };

  for (const { block, data } of results) {
    switch (block) {
      case 'stats':
        response.stats = data;
        break;
      case 'charts':
        response.charts = data;
        break;
      case 'doctors':
        response.doctorsOverview = data;
        break;
      case 'upcoming':
        response.upcomingAppointments = data;
        break;
    }
  }

  return response;
}

/**
 * Pré-aquece todos os blocos do dashboard logo após startup.
 * Elimina o cold start de 4s na primeira requisição do usuário.
 */
export async function warmupDashboardCache() {
  try {
    console.log('[DashboardCache] 🔥 Warmup iniciado...');
    const start = Date.now();
    await buildDashboardOverview(Object.keys(BLOCKS), false);
    console.log(`[DashboardCache] ✅ Warmup concluído em ${Date.now() - start}ms`);
  } catch (err) {
    console.warn('[DashboardCache] ⚠️ Warmup falhou (não crítico):', err.message);
  }
}

/**
 * Invalida cache de blocos específicos
 */
export async function invalidateDashboardBlocks(blockNames = Object.keys(BLOCKS)) {
  for (const name of blockNames) {
    if (BLOCKS[name]) {
      await dashboardCache.invalidate(BLOCKS[name].cacheKey);
    }
  }
}
