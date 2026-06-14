# Mapa de Consumidores Financeiros — Sprint 3.10

> Data: 2026-06-13
> Objetivo: identificar quem consome cada endpoint financeiro para planejar remoção dos legados.

---

## Endpoints ativos (V2)

| Endpoint | Arquivo no front | Componente/página | Status |
|---|---|---|---|
| `GET /api/v2/cashflow` | `src/services/cashflowService.ts` | `UnifiedCashflowTab.tsx`, `DailySummaryCard.tsx` | ✅ Ativo |
| `GET /api/v2/cashflow/month` | `src/services/cashflowService.ts` | `UnifiedCashflowTab.tsx` | ✅ Ativo |
| `GET /api/v2/financial/dashboard` | `src/hooks/useFinancialDashboard.ts` | `FinancialDashboard.tsx` | ✅ Ativo |
| `GET /api/v2/financial/dashboard` | `src/hooks/useFinancialDashboardV3.ts` | `FinancialDashboard.tsx` | ✅ Ativo |
| `GET /api/v2/financial/dashboard/sanity-check` | `src/components/admin/SystemUnifiedDashboard.tsx` | Dashboard admin | ✅ Ativo |
| `GET /api/v2/analytics/operational/recent-ops` | `src/components/admin/SystemUnifiedDashboard.tsx` | Dashboard admin | ✅ Ativo |
| `GET /api/v2/operational/patients-without-next-session` | `src/services/operationalService.ts` | Operações | ✅ Ativo |

---

## Endpoints legados ainda consumidos

| Endpoint | Arquivo no front | Componente/página | Status | Ação |
|---|---|---|---|---|
| `GET /api/financial/dashboard/debitos` | `src/pages/Financial/tabs/DashboardV3Tab.tsx` | `DashboardV3Tab` → `/admin/financial` | ⚠️ Legado ativo | Migrar para `/api/v2/financial/dashboard` |
| `GET /api/financial/dashboard/projection-daily` | `src/pages/Financial/tabs/AnaliseProjecaoTab.tsx` | `AnaliseProjecaoTab` → `/admin/financial` | ⚠️ Legado sob observação | Não reescrever agora. Medir uso real por 7-15 dias; ver [`SPRINT_3_10_1_AUDITORIA_PROJECAO_CENARIOS.md`](../../SPRINT_3_10_1_AUDITORIA_PROJECAO_CENARIOS.md) e [`SPRINT_3_10_2_MEDICAO_USO_PROJECAO.md`](../../SPRINT_3_10_2_MEDICAO_USO_PROJECAO.md) |
| `GET /api/cashflow/summary` | `src/pages/Financial/legacy/CashflowTab.original.tsx` | Componente legacy | ⚠️ Legado inativo? | Verificar se rota `/admin/financial/legacy` existe |
| `GET /api/cashflow/summary?period=day` | `src/hooks/useDashboardMinimal.ts` | Nenhum import ativo | ⚠️ Código morto | Remover hook ou migrar |

---

## Evidências de MetricLog (últimos 30 dias)

```
┌────────────────────────────────────┬────────┐
│ Service:Operation                    │ Count  │
├────────────────────────────────────┼────────┤
│ LegacyFinancialMetrics:getOverview   │ 9      │
│ LegacyCashflow:request               │ 0      │
│ LegacyFinancialDashboard:request     │ 0      │
└────────────────────────────────────┴────────┘
```

> Nota: os 9 logs de `LegacyFinancialMetrics:getOverview` ocorreram no mesmo dia da instrumentação (2026-06-13), provavelmente por testes/diagnóstico. Em produção, o consumo parece baixo ou nulo.

---

## Recomendações

### Imediato (Sprint 3.10)

1. **Remover `/api/cashflow/summary`**
   - Front: `CashflowTab.original.tsx` parece não estar em rota ativa.
   - Hook `useDashboardMinimal.ts` não é importado.
   - Back: `routes/financial/cashflow.js` já está instrumentado com `LegacyCashflow`.

2. **Migrar `/api/financial/dashboard/debitos`**
   - `DashboardV3Tab.tsx:141` e `:159` chamam `/debitos`.
   - Substituir por dados de `/api/v2/financial/dashboard` (campo `debitos` ou similar).

3. **Decidir sobre `/api/financial/dashboard/projection-daily`**
   - Ação atual: **não reescrever** (evitar Opção B).
   - Medir uso real via `ProjectionTab.opened` e `LegacyFinancialDashboard.projection-daily-request`.
   - Se uso ≈ zero → remover aba e endpoint.
   - Se uso moderado → incorporar necessidades na aba **Metas**.
   - Se uso estratégico → módulo moderno na Sprint 4.
   - Ver [`SPRINT_3_10_1_AUDITORIA_PROJECAO_CENARIOS.md`](../../SPRINT_3_10_1_AUDITORIA_PROJECAO_CENARIOS.md) e [`SPRINT_3_10_2_MEDICAO_USO_PROJECAO.md`](../../SPRINT_3_10_2_MEDICAO_USO_PROJECAO.md).

### Sprint 3.11

4. Após confirmar zero chamadas nos endpoints legados por 7 dias:
   - Remover `back/routes/financial/cashflow.js`
   - Remover `back/routes/financial/dashboard.routes.js`
   - Remover `back/services/financialMetrics.service.js`

### Sprint 4

5. Nenhum endpoint legado deve existir antes de liberar o Centro de Resultado dos Profissionais.

---

## Verificação rápida

Para confirmar se um endpoint legado ainda recebe chamadas em produção:

```bash
# Atlas Metrics ou MongoDB Compass
use fono_inova_prod
db.metriclogs.find({
  service: { $in: ['LegacyCashflow', 'LegacyFinancialDashboard', 'LegacyFinancialMetrics'] },
  timestamp: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
})
```
