# Mapa de Deprecação — Domínio Financeiro

> **Sprint 3.10 — Consolidação Arquitetural**
>
> Gerado em: 2026-06-13
>
> Objetivo: eliminar motores financeiros paralelos antes de construir novas features no Centro de Resultado dos Profissionais.

---

## Legenda

| Classificação | Significado |
|---------------|-------------|
| **ACTIVE** | Em uso por rotas/workers/crons atuais. Não remover. |
| **LEGACY** | Ainda recebe chamadas, mas existe substituto funcional. Migrar e remover. |
| **DEPRECATED** | Não deveria mais ser usado. Possui substituto funcional. |
| **DEAD** | Sem importações ou referências ativas. Pode ser removido com baixo risco. |

---

## Matriz Resumida

| # | Arquivo | Classificação | Substituição Recomendada | Risco de Remoção |
|---|---------|---------------|--------------------------|------------------|
| 1 | ~~`back/workers/financialSnapshotWorker.js`~~ | **REMOVIDO** | `back/workers/financialSnapshotWorker.v2.js` | — |
| 2 | ~~`back/routes/financial/totals-wrapper.routes.js`~~ | **REMOVIDO** | `/api/v2/cashflow` | — |
| 3 | ~~`back/routes/financial/overview.routes.js`~~ | **REMOVIDO** | `/api/v2/financial/dashboard` | — |
| 4 | `back/routes/financial/cashflow.js` | **DEPRECATED** | `/api/v2/cashflow` | Baixo |
| 5 | `back/services/financialMetrics.service.js` | **DEPRECATED** | `back/services/unifiedFinancialService.v2.js` | Médio |
| 6 | `back/routes/financial/dashboard.routes.js` | **LEGACY** | `/api/v2/financial/dashboard` | Médio |
| 7 | `back/services/commissionService.js` | **ACTIVE** | `ProfessionalFinancialService` (futuro) | Médio |
| 8 | `back/services/financial/financialAnalytics.service.js` | **ACTIVE** | — (mas duplica lógica) | Médio |
| 9 | `back/services/unifiedFinancialService.v2.js` | **ACTIVE** | — | Alto (não remover) |
| 10 | `back/routes/financialDashboard.v2.js` | **ACTIVE** | — | Alto (não remover) |
| 11 | `back/routes/cashflow.v2.js` | **ACTIVE** | — | Alto (não remover) |
| 12 | `back/services/paymentStatusService.js` | **ACTIVE** | — | Alto (não remover) |
| 13 | `back/workers/financialSnapshotWorker.v2.js` | **ACTIVE** | — | Médio (avaliar fusão com event-driven) |
| 14 | `FinancialProjection` (modelo/worker) | **DEPRECATED** | Nenhum | Baixo |
| 15 | `TotalsSnapshot` (modelo/worker) | **DEPRECATED** | Nenhum | Baixo |
| 16 | `FinancialDailySnapshot` (modelo/worker) | **DEPRECATED** | Nenhum | Baixo |

---

## Plano de Consolidação

### Sprint 3.10 — Fonte Única de Verdade

- [x] Atualizar `docs/FINANCIAL_SOURCE_OF_TRUTH.md`
- [x] Documentar `paymentStatusService` como fonte única de mudança de status
- [x] Adicionar campos `minValue`, `maxValue`, `effectiveDate` nas regras de comissão
- [x] Garantir índices físicos via `scripts/ensure-indexes.js`
- [x] Desligar `autoIndex` em produção (`back/server.js`)
- [ ] Mapear consumidores dos endpoints `/financial/dashboard`, `/cashflow`, `/operational`
- [ ] Confirmar zero chamadas aos endpoints legados por 7 dias consecutivos

### Sprint 3.11 — Payment Status Service único

- [ ] Verificar que 100% das mudanças de `Payment.status` passam por `paymentStatusService`
- [ ] Remover `financialSnapshotWorker.v2.js` se tornar obsoleto
- [ ] Remover `FinancialProjection`, `TotalsSnapshot`, `FinancialDailySnapshot`
- [ ] Remover `back/routes/financial/cashflow.js`
- [ ] Refatorar `back/services/financialMetrics.service.js` para delegar ao `unifiedFinancialService.v2.js`

### Sprint 4 — Centro de Resultado dos Profissionais

- [ ] Ranking
- [ ] Summary por profissional
- [ ] Pacientes do profissional
- [ ] Sessões do paciente
- [ ] Pagamentos da sessão
- [ ] Adiantamentos e fechamentos
- [ ] Auditoria integrada

---

## Duplicidades Confirmadas

| # | O que está duplicado | Onde | Recomendação |
|---|----------------------|------|--------------|
| 1 | Cálculo de CAIXA | `unifiedFinancialService.v2.js`, `financialMetrics.service.js`, `financial/dashboard.routes.js`, `financial/cashflow.js` | Consolidar em `unifiedFinancialService.v2.js` |
| 2 | Cálculo de PRODUÇÃO | `unifiedFinancialService.v2.js`, `financialMetrics.service.js`, `financialAnalytics.service.js`, `ConvenioMetricsService.js`, `financial/dashboard.routes.js` | Usar `unifiedFinancialService.calculateProduction()` |
| 3 | Cálculo de COMISSÃO | `Session.commissionValue` (imutável), `commissionService.calculateDoctorCommission()` | Usar `Session.commissionSnapshot` como oficial; `commissionService` vira auditoria |
| 4 | Snapshot financeiro | `financialSnapshotWorker.js` (morto), `financialSnapshotWorker.v2.js` (ativo) | Remover V1; avaliar se V2 ainda é necessário com eventos |
| 5 | Dashboard financeiro | `financial/dashboard.routes.js` (legado), `financialDashboard.v2.js` (ativo) | Migrar front e remover V1 |
| 6 | Cashflow | `financial/cashflow.js` (deprecated), `cashflow.v2.js` (ativo) | Remover V1 |
| 7 | Overview financeiro | `financial/dashboard.routes.js`, `financialDashboard.v2.js`, `cashflow.v2.js` | Consolidar em `/api/v2/financial/dashboard` |
| 8 | Métricas de convênio | `ConvenioMetricsService.js`, `financialMetrics.service.js`, `financialAnalytics.service.js` | Centralizar em `ConvenioMetricsService.js` ou novo domínio de insurance |
| 9 | Mudança de status de Payment | `paymentStatusService.js` (oficial) vs `Payment.findByIdAndUpdate` em testes antigos | Eliminar updates diretos em produção |

---

## Regras para novos desenvolvimentos

1. **Produção** só pode ser calculada por `unifiedFinancialService.v2.js` ou `resolveSessionFinancialValue()`.
2. **Caixa** só pode ser calculado por `unifiedFinancialService.v2.js`.
3. **Comissão** oficial é `Session.commissionSnapshot` (imutável).
4. **Mudança de status de Payment** só pode ser feita por `paymentStatusService.transitionPaymentStatus()`.
5. **Appointment** não pode ser usado como base financeira.
6. Não criar novos cálculos financeiros paralelos.
7. Não criar novos snapshots/projeções sem aprovação explícita.
