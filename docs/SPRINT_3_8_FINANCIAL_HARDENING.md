# Sprint 3.8 — Hardening Financeiro

> **Status:** Implementado em 12/06/2026
>
> **Objetivo:** eliminar cálculos de comissão fora do motor oficial, versionar regras de comissão e criar snapshot imutável por sessão.

---

## Problema

Após a Sprint 3.7, a comissão oficial vinha de:

```text
Doctor.commissionRules
↓
commissionRule.service
↓
commissionService / ProfessionalFinancialService / ProfessionalSettlement
```

Mas ainda existiam:

- `Session.commissionValue` / `Session.commissionRate` calculados por hooks legados.
- Relatórios que liam `Session.commissionValue` como fonte de verdade.
- Cálculos manuais de comissão espalhados.

Isso criava risco de divergência e auditoria fraca.

---

## Solução

### 1. Versionamento das regras de comissão

`Doctor.commissionRuleVersion` agora existe e é incrementado automaticamente a cada:

- Criação de regra
- Atualização de regra
- Remoção de regra

Isso permite rastrear exatamente qual versão das regras estava vigente em qualquer fechamento ou sessão.

### 2. Snapshot de comissão por sessão

`Session.commissionSnapshot` foi criado:

```js
commissionSnapshot: {
  ruleId,
  version,              // versão das regras no momento do complete
  commissionType,       // 'fixed' | 'percentage'
  value,                // valor bruto da regra
  calculatedCommission, // valor final calculado
  calculatedAt          // quando foi calculado
}
```

Esse snapshot é preenchido automaticamente quando uma sessão é completada via `completeSessionService.v2.js`.

### 3. Remoção dos hooks legados

Os hooks `pre('save')` e `pre('findOneAndUpdate')` de `Session.js` não calculam mais `commissionValue = sessionValue * commissionRate`.

`Session.commissionValue` e `Session.commissionRate` continuam no schema apenas como **campos legados**, marcados como não confiáveis.

### 4. Auditoria baseada no motor oficial

`ProfessionalFinancialService.getCommissionAudit` e `ReconciliationService.isCommissionMismatch` agora usam `calculateSessionCommission()` do `commissionRule.service`.

A lógica de mismatch:

```text
Se não existe commissionSnapshot → mismatch
Se existe doctor e snapshot difere do cálculo atual → mismatch
Se não existe doctor → confia no snapshot
```

### 5. Endpoint de simulação

```http
GET /api/v2/professionals/:id/commission-simulation?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
```

Retorna:

```json
{
  "doctorId": "...",
  "doctorName": "Ana Paula",
  "version": 7,
  "period": { "start": "2026-06-01", "end": "2026-06-30" },
  "sessions": 132,
  "production": 18200,
  "commission": 9549,
  "breakdown": { ... },
  "rulesApplied": [ ... ]
}
```

Isso permite à gestão validar a comissão contra planilhas manuais antes de fechar o período.

### 6. Congelamento da versão no fechamento

`ProfessionalSettlement.snapshot` agora inclui:

```js
snapshot: {
  ...,
  commissionRuleVersion: 7
}
```

Garantindo que o fechamento histórico reflita a versão exata das regras daquele mês.

---

## Arquivos alterados

### Backend
- `back/models/Doctor.js` — adicionado `commissionRuleVersion`.
- `back/models/Session.js` — adicionado `commissionSnapshot`, removidos cálculos legados dos hooks.
- `back/services/commissionRule.service.js` — versionamento, `createCommissionSnapshot`, `simulateCommission`.
- `back/services/completeSessionService.v2.js` — preenche `commissionSnapshot` no complete.
- `back/services/professionalFinancial.service.js` — `getCommissionAudit` usa motor oficial.
- `back/services/reconciliation.service.js` — `isCommissionMismatch` usa motor oficial.
- `back/services/professionalSettlement.service.js` — congela `commissionRuleVersion`.
- `back/routes/professionalFinancial.routes.js` — endpoint `/commission-simulation`.

---

## Testes

Rodar:

```bash
cd back
npx vitest run tests/unit/commissionRule.service.test.js
```

---

## Próximos passos

1. **Backfill histórico**: preencher `commissionSnapshot` nas sessões `completed` antigas usando `commissionRule.service`.
2. **Remover campos legados**: após validação, remover `Session.commissionValue` e `Session.commissionRate` do schema.
3. **Migrar relatórios**: `financialMetrics.service.js` e `operational.routes.js` ainda agregam `Session.commissionValue`; devem migrar para `commissionService` ou `commissionRule.service`.
4. **Sprint 4**: Centro de Resultado já consome base financeira consistente.
