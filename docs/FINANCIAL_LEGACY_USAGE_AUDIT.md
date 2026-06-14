# Auditoria de Uso — Componentes Financeiros Legados

> Data: 2026-06-13
> Objetivo: mapear leituras e escritas de `FinancialProjection`, `TotalsSnapshot` e `FinancialDailySnapshot` antes de removê-los.

---

## Resumo

| Componente | Leituras | Escritas | Pode remover? |
|---|---|---|---|
| **FinancialDailySnapshot** | Alta (dashboard V2, audit, scripts, cron) | `financialSnapshotWorker.v2.js` | ❌ Não — ainda usado ativamente |
| **TotalsSnapshot** | Baixa (`routes/totals.v2.js`, debug) | `totalsWorker.js` | ⚠️ Quase — avaliar consumidores |
| **FinancialProjection** | `reconciliationWorker.js`, `projections/financialProjection.js` | `paymentWorker.js`, `projections/financialProjection.js` | ⚠️ Médio — usado em reconciliação |

---

## Tabela detalhada

| Componente | Operação | Arquivo | Linha(s) | O que faz |
|---|---|---|---|---|
| **FinancialDailySnapshot** | Leitura | `services/financialSnapshot.service.js` | 25, 121, 135 | Agrega snapshots para ranges mensais |
| | Leitura | `routes/financialDashboard.v2.js` | 489 | `deleteMany` (limpeza) |
| | Leitura | `routes/financial/dashboard.routes.js` | 552–553 | `/projection-daily` legado |
| | Leitura | `routes/financial/audit.routes.js` | 11 | Auditoria V1 vs V2 |
| | Leitura | `workers/financialSnapshotWorker.v2.js` | 63, 407 | Verifica existência antes de escrever |
| | Leitura | `crons/financialSnapshotAudit.cron.js` | 11 | Auditoria automática diária |
| | Leitura | `scripts/test-consistency.js` | 46 | Compara realtime vs snapshot |
| | Leitura | `scripts/operational-audit-junho.js` | 74, 254 | Auditoria operacional |
| | Leitura | `scripts/backfillFinancialSnapshot.js` | 288, 296, 471 | Backfill e correção |
| | Escrita | `workers/financialSnapshotWorker.v2.js` | 85, 349 | `findOneAndUpdate` diário |
| | Escrita | `routes/financialDashboard.v2.js` | 2150 | `rebuild-snapshot` |
| **TotalsSnapshot** | Leitura | `routes/totals.v2.js` | 38 | Endpoint `/api/v2/totals/*` |
| | Leitura | `routes/debug/financial-debug.routes.js` | 4 | Debug interno |
| | Escrita | `workers/totalsWorker.js` | 128 | `findOneAndUpdate` |
| **FinancialProjection** | Leitura | `workers/reconciliationWorker.js` | 235 | Verifica Payment ↔ FinancialProjection |
| | Leitura | `projections/financialProjection.js` | 50 | Próprio handler lê para atualizar |
| | Escrita | `workers/paymentWorker.js` | 413, 982 | `FinancialProjectionHandler.updateCash()` |
| | Escrita | `projections/financialProjection.js` | 23 | `findOneAndUpdate` |
| | Escrita | `server.js` | 791–792 | Inicia o handler |

---

## FinancialDailySnapshot

### Leituras

| Arquivo | Uso |
|---|---|
| `services/financialSnapshot.service.js` | Agrega snapshots para ranges mensais |
| `routes/financialDashboard.v2.js` | `deleteMany`, `rebuild-snapshot`, `validate-snapshot` |
| `routes/financial/dashboard.routes.js` | `/projection-daily` (legado) |
| `routes/financial/audit.routes.js` | Auditoria V1 vs V2 |
| `workers/financialSnapshotWorker.v2.js` | Verifica existência antes de escrever |
| `crons/financialSnapshotAudit.cron.js` | Auditoria automática diária |
| `scripts/test-consistency.js` | Compara realtime vs snapshot |
| `scripts/operational-audit-junho.js` | Auditoria operacional |
| `scripts/backfillFinancialSnapshot.js` | Backfill e correção |

### Escritas

| Arquivo | Uso |
|---|---|
| `workers/financialSnapshotWorker.v2.js` | `findOneAndUpdate` diário |
| `routes/financialDashboard.v2.js` | `rebuild-snapshot` |

### Conclusão

Ainda é usado ativamente pelo dashboard V2 (rebuild/validate) e pelo legado `/projection-daily`. **Não remover na Sprint 3.10.** A remoção depende de:
1. Medir uso real de `/projection-daily` via `LegacyFinancialDashboard.projection-daily-request` (ver [`SPRINT_3_10_2_MEDICAO_USO_PROJECAO.md`](../../SPRINT_3_10_2_MEDICAO_USO_PROJECAO.md)).
2. Avaliar se `financialSnapshotWorker.v2.js` ainda é necessário.

---

## TotalsSnapshot

### Leituras

| Arquivo | Uso |
|---|---|
| `routes/totals.v2.js` | Endpoint `/api/v2/totals/*` |
| `routes/debug/financial-debug.routes.js` | Debug interno |

### Escritas

| Arquivo | Uso |
|---|---|
| `workers/totalsWorker.js` | Atualização periódica |

### Conclusão

Poucos consumidores. Verificar se `/api/v2/totals/*` é usado no front. Se não for, pode ser removido na Sprint 3.11-C.

---

## FinancialProjection

### Leituras

| Arquivo | Uso |
|---|---|
| `workers/reconciliationWorker.js` | Verifica Payment ↔ FinancialProjection |
| `projections/financialProjection.js` | Próprio handler lê para atualizar |

### Escritas

| Arquivo | Uso |
|---|---|
| `workers/paymentWorker.js` | Chama `FinancialProjectionHandler.updateCash()` |
| `projections/financialProjection.js` | `findOneAndUpdate` |
| `server.js` | Inicia o handler |

### Conclusão

Usado na reconciliação e atualizado pelo paymentWorker. **Não remover sem substituir a lógica de reconciliação.** Avaliar se a reconciliação ainda precisa dessa projeção ou se pode usar `unifiedFinancialService`.

---

## Recomendação de ordem de remoção

1. **Sprint 3.11-A**: migrar consumidores do front (`DashboardV3Tab`).
2. **Sprint 3.11-B**: remover `routes/financial/cashflow.js`, `routes/financial/dashboard.routes.js`, `services/financialMetrics.service.js`.
3. **Sprint 3.11-C**:
   - Verificar uso real de `/api/v2/totals/*`.
   - Decidir se `FinancialDailySnapshot` ainda é necessário sem `/projection-daily`.
   - Avaliar se `FinancialProjection` pode ser substituído por `unifiedFinancialService` na reconciliação.

---

## Comando de verificação

```bash
cd back
grep -R "FinancialProjection" --include="*.js" -n .
grep -R "TotalsSnapshot" --include="*.js" -n .
grep -R "FinancialDailySnapshot" --include="*.js" -n .
```
