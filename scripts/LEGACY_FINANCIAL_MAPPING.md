# Mapeamento de Legado Financeiro — Dashboard / Caixa / Convênios / Pacotes

> Gerado em: 2026-07-30  
> Objetivo: identificar o que pode ser removido com segurança no backend financeiro, sem perder regra de negócio ativa.

## 1. Critérios de classificação

| Classificação | Significado | Pode apagar? |
|---|---|---|
| **Morto confirmado** | Não é importado por nenhuma rota ativa, worker, cron ou frontend. | ✅ Sim, após backup/PR isolada |
| **Legado ativo** | Ainda é chamado por rota/frontend/worker. | ❌ Não — precisa migrar primeiro |
| **Deprecado com fallback** | Rota existe mas redireciona/loga uso legado. | ⚠️ Avaliar tráfego antes |
| **Legado por testes** | Só usado em testes, não em produção. | ⚠️ Remover junto com os testes |
| **Duplicado V1/V2** | Existe versão V2 equivalente. | ⚠️ Migrar frontend/worker antes |

## 2. Rotas V1 financeiras registradas em `server.js`

| Rota V1 | Importa de | Status | Implementação | Usada pelo frontend? | Ação recomendada |
|---|---|---|---|---|---|
| `/api/packages` | `server.js:515` | Stub 410 | Retorna erro: use `/api/v2/packages` | Apenas teste legado | ✅ Remover stub |
| `/api/payments` | `server.js:521` | Stub 410 | Retorna erro: use `/api/v2/payments` | Não | ✅ Remover stub |
| `/api/cashflow` | `routes/financial/cashflow.js` | **Legado ativo** | Deprecation warning + lógica real de aggregate | `ProvisionamentoTab.tsx` | ❌ Migrar frontend primeiro |
| `/api/financial/dashboard` | `routes/financial/dashboard.routes.js` | **Legado ativo** | Deprecation warning + lógica real | Possivelmente | ❌ Migrar frontend primeiro |
| `/api/expenses` | `routes/financial/expense.js` | **Legado ativo** | CRUD real de despesas | Sim | ❌ Migrar para `/api/v2/expenses` |
| `/api/insurance-guides` | `server.js:567` | Stub 410 | Retorna erro: use `/api/v2/insurance-guides` | Não | ✅ Remover stub |
| `/api/convenio-packages` | `routes/convenioPackages.js` | **Legado ativo** | `convenioPackageController.js` | Não | ⚠️ Verificar se ainda cria dados |
| `/api/financial/convenio` | `routes/financial/convenio.routes.js` | Ativo | Convênio legado | `front/src/hooks/useFinancialMetrics` | ❌ Avaliar uso |
| `/api/provisionamento` | `routes/provisionamento.js` | **Legado ativo** | `provisionamentoService.js` | `ProvisionamentoTab.tsx` | ❌ Migrar frontend primeiro |
| `/api/analytics/financial` | `routes/analytics/financial.routes.js` | Ativo | Analytics financeiro | Possivelmente | ⚠️ Mapear uso |
| `/api/analytics/revenue` | `routes/analytics.js` | Ativo | Revenue analytics | Possivelmente | ⚠️ Mapear uso |
| `/api/daily-closing-simple` | `routes/dailyClosingSimple.routes.js` | Ativo | Fechamento simplificado | Possivelmente | ⚠️ Mapear uso |
| `/api/internal/financial` | `routes/internal/financial/reconciliation.routes.js` | Ativo | Reconciliação interna | Admin | ⚠️ Mapear uso |

## 3. Controllers / Services financeiros legados

| Arquivo | Rota ativa? | Worker/Cron? | Frontend? | Testes? | Status | Pode apagar? |
|---|---|---|---|---|---|---|
| `controllers/convenioPackageController.js` | `/api/convenio-packages` | Não | Não | Sim | Legado ativo (pouco uso) | ⚠️ Migrar dados/frontend |
| `controllers/therapyPackageController.js` | ❌ Nenhuma | Não | Não | Sim (integração) | **Morto confirmado** | ✅ Sim — após remover testes |
| `controllers/packageSessionController.js` | ❌ Nenhuma | Não | Não | Não | **Morto confirmado** | ✅ Sim |
| `controllers/insuranceBatchController.js` | ❌ Nenhuma | Não | Não | Não | **Morto confirmado** | ✅ Sim |
| `controllers/financialMetricsController.js` | `/api/financial/v2` | Não | Sim | Não | Ativo | ❌ Não |
| `services/paymentService.js` | ❌ Ninguém importa | Não | Não | Não | **Morto confirmado** | ✅ Sim |
| `services/packageService.js` | ❌ Ninguém importa | Não | Não | Não | **Morto confirmado** | ✅ Sim |
| `services/financialMetrics.service.js` | Várias rotas | Não | Indireto | Mock | Deprecado, mas ativo | ❌ Avaliar remoção |
| `services/financialEngine.js` | Rotas V2 | Não | Não | Sim | Ativo | ❌ Não |
| `services/provisionamentoService.js` | `/api/provisionamento`, `/api/sales`, hook `Session.js` | Indireto | Não | Sim | **Legado ativo** | ❌ Migrar primeiro |
| `services/unifiedFinancialService.v2.js` | `/api/v2/cashflow` | Não | Não | Sim | Ativo (V2) | ❌ Não |

## 4. Read Models / Snapshots — situação

| Coleção | Docs | Alimentada? | Usada por endpoint ativo? | Situação |
|---|---|---|---|---|
| `financialdailysnapshots` | 239 | ✅ Sim | Dashboard V2 (parcial) | ✅ OK |
| `paymentsviews` | 0 | ❌ Não | `/api/v2/payments` (fallback) | 🔥 Deveria ser populada |
| `insuranceguideviews` | 0 | ❌ Não | Ninguém | 🔥 Órfã |
| `insurancebatchviews` | 0 | ❌ Não | Ninguém | 🔥 Órfã |
| `packagesviews` | 1 | ⚠️ Parcial | `/api/v2/packages` | ⚠️ Precisa de rebuild |
| `patientbalances` | 30 | ✅ Sim | Pacote/liminar | ✅ OK |
| `liminarcontractviews` | 0 | ❌ Não | Não existe | N/A |
| `liminarviews` | 0 | ❌ Não | Não existe | N/A |

## 5. Ranking de remoção segura

### 5.1 Pode remover agora (baixo risco)

1. **Stubs 410 no `server.js`**
   - `/api/packages`
   - `/api/payments`
   - `/api/insurance-guides`
   - São só redirecionadores para V2. Não têm lógica.

2. **Controllers sem rota ativa**
   - `controllers/therapyPackageController.js` (remover testes que o usam)
   - `controllers/packageSessionController.js`
   - `controllers/insuranceBatchController.js`

3. **Services sem consumidor**
   - `services/paymentService.js`
   - `services/packageService.js`

### 5.2 Só depois de migrar frontend/worker

1. `/api/cashflow` → `/api/v2/cashflow`
2. `/api/financial/dashboard` → `/api/v2/financial/dashboard`
3. `/api/provisionamento` → `/api/v2/???`
4. `/api/expenses` → `/api/v2/expenses`
5. `/api/convenio-packages` → `/api/v2/insurance-guides` ou `/api/v2/packages`
6. `services/provisionamentoService.js` (usado por hook de Session)

### 5.3 Não remover (ainda ativos)

- `controllers/financialMetricsController.js`
- `services/financialEngine.js`
- `services/financialMetrics.service.js` (deprecado, mas ainda chamado)
- `services/unifiedFinancialService.v2.js`
- `services/insuranceBatchService.js`
- `services/insuranceBatchGuideAdapter.js`

## 6. Estimativa de limpeza

| Categoria | Quantidade | Risco |
|---|---|---|
| Stubs V1 | 3 rotas | 🟢 Baixo |
| Controllers mortos | 3 arquivos | 🟢 Baixo |
| Services mortos | 2 arquivos | 🟢 Baixo |
| Rotas V1 ativas com V2 | 5+ rotas | 🟡 Médio |
| Read Models órfãs | 3 coleções | 🟡 Médio |

**Ganho esperado da limpeza segura (fase 1):**
- Redução de ~8 arquivos mortos.
- Menor confusão no `server.js` e `controllers/`.
- Menor superfície de manutenção.

**Ganho esperado da migração V2 (fase 2):**
- Eliminação de cálculos duplicados (`/api/cashflow` vs `/api/v2/cashflow`).
- Eliminação de rotas V1 que ainda fazem aggregate pesado.
- Frontend unificado nas V2.

## 7. Recomendação de execução

### Fase A — Remoção segura (1 PR)
- Remover stubs 410 de `/api/packages`, `/api/payments`, `/api/insurance-guides`.
- Remover `controllers/therapyPackageController.js`, `packageSessionController.js`, `insuranceBatchController.js`.
- Remover `services/paymentService.js`, `services/packageService.js`.
- Ajustar testes que importam controllers removidos.

### Fase B — Migração de rotas V1 ativas (1 PR por rota)
- Mapear uso real no frontend para `/api/cashflow`, `/api/financial/dashboard`, `/api/provisionamento`, `/api/expenses`, `/api/convenio-packages`.
- Migrar frontend/worker para V2 equivalente.
- Desativar rota V1 com deprecation log.
- Depois de 7 dias sem tráfego, remover.

### Fase C — Decidir Read Models órfãs (1 PR)
- Popular ou remover `PaymentsView`, `InsuranceGuideView`, `InsuranceBatchView`.
- Se forem usar em breve: fazer rebuild + worker.
- Se não forem usar: remover modelos e código relacionado.

---

## 8. Próximo passo recomendado

Antes de qualquer `rm`, executar um **scan de tráfego real** em produção (últimos 7 dias) nas rotas V1 ativas. Sem isso, não dá para afirmar que ninguém usa.
