// routes/analytics/attribution.routes.js
// Frente 2 — Attribution. SOMENTE LEITURA: nenhuma rota aqui grava no banco nem chama plataforma.
// Montado em /api/v2/analytics (server.js).
// Acesso: SÓ ADMIN (receita da clínica). Segue o padrão das rotas financeiras restritas
// (ex.: routes/financial/dashboard.routes.js /reconciliation, routes/admin/financialMetrics.routes.js):
// `auth` (JWT de usuário, confere que o usuário existe e está ativo) + `authorize(['admin'])`.
// Sem token → 401; secretária/profissional → 403. Tokens de serviço (Amanda/Agenda) não entram.
// Quem pode ver a receita é decisão do dono da clínica; admin-only é o padrão.
//
//   GET /api/v2/analytics/roi/revenue-attribution?from=YYYY-MM-DD&to=YYYY-MM-DD
//   GET /api/v2/analytics/attribution-health?from=YYYY-MM-DD&to=YYYY-MM-DD
//
// Doc: docs/RECEITA_POR_CAMPANHA.md

import express from 'express';
import { auth as userAuth, authorize } from '../../middleware/auth.js';
import { asyncHandler } from '../../middleware/errorHandler.js';
import { loadRevenueAttribution, REGRAS } from '../../services/attribution/revenueAttribution.js';
import { loadAttributionHealth } from '../../services/attribution/attributionHealth.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Mesma convenção de routes/analytics/roi.routes.js#resolveWindow: dia inteiro em America/Sao_Paulo
// (-03:00); startDate/endDate aceitos como alias. Sem datas: últimos 30 dias.
export function parsePeriod(q = {}, now = Date.now()) {
  const pick = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');
  const from = pick(q.from, q.startDate);
  const to = pick(q.to, q.endDate);
  for (const [nome, v] of [['from', from], ['to', to]]) {
    if (v !== undefined && !(typeof v === 'string' && DATE_RE.test(v))) {
      return { error: `Parâmetro ${nome} inválido: use YYYY-MM-DD` };
    }
  }
  const since = from ? new Date(`${from}T00:00:00.000-03:00`) : new Date(now - 30 * 864e5);
  const until = to ? new Date(`${to}T23:59:59.999-03:00`) : new Date(now);
  if (Number.isNaN(since.getTime()) || Number.isNaN(until.getTime())) return { error: 'Data inválida' };
  if (since > until) return { error: 'from deve ser anterior ou igual a to' };
  return { since, until, from: from || null, to: to || null };
}

export const ADMIN_ONLY = Object.freeze([userAuth, authorize(['admin'])]);

export function createAttributionRouter({ auth = ADMIN_ONLY, models } = {}) {
  const router = express.Router();
  const guard = [].concat(auth);

  router.get('/roi/revenue-attribution', ...guard, asyncHandler(async (req, res) => {
    const p = parsePeriod(req.query);
    if (p.error) return res.status(400).json({ success: false, error: p.error });
    const data = await loadRevenueAttribution({ since: p.since, until: p.until, models });
    if (!data.invariante.fecha) {
      console.error('[RevenueAttribution] invariante não fechou', data.invariante);
    }
    res.json({
      success: true,
      meta: {
        periodo: { from: p.from, to: p.to, since: p.since.toISOString(), until: p.until.toISOString(), campo: 'FinancialLedger.occurredAt' },
        moeda: 'BRL',
        somenteLeitura: true,
        regras: REGRAS,
      },
      data,
    });
  }));

  router.get('/attribution-health', ...guard, asyncHandler(async (req, res) => {
    const p = parsePeriod(req.query);
    if (p.error) return res.status(400).json({ success: false, error: p.error });
    const data = await loadAttributionHealth({ since: p.since, until: p.until, models });
    res.json({
      success: true,
      meta: {
        periodo: { from: p.from, to: p.to, since: p.since.toISOString(), until: p.until.toISOString(), campo: 'AdConversion.eventTime' },
        somenteLeitura: true,
        nota: 'Lido do AdConversion. Enviado com prova = resposta documentada da API; sem prova = histórico. google_csv: estar no feed não prova importação pelo Google.',
      },
      data,
    });
  }));

  return router;
}

export default createAttributionRouter();
