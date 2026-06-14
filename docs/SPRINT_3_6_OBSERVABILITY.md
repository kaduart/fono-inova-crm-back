# Sprint 3.6 — Observabilidade dos Serviços Financeiros

> **Status:** Concluída em 12/06/2026
>
> **Escopo:** adicionar métricas estruturadas e logs nos serviços financeiros que sustentam o Centro de Resultado dos Profissionais, preparando o backend para a Sprint 4 (Dashboard).

---

## Serviços instrumentados

| Serviço | Operações com métricas |
|---|---|
| `ProfessionalFinancialService` | `getProfessionalSummary`, `getProfessionalPatientsBreakdown`, `getProfessionalRanking`, `getCommissionAudit` |
| `ReconciliationService` | `getGlobalReconciliation`, `getDoctorReconciliation`, `getTopFinancialIssues` |
| `ProfessionalSettlementService` | `previewSettlement`, `closeMonthlySettlement`, `getDoctorSettlements`, `getSettlement`, `cancelSettlement` |

---

## Formato do log

Todas as métricas são emitidas como JSON em `stdout` com `level: 'metric'`:

```json
{
  "level": "metric",
  "service": "ProfessionalFinancialService",
  "operation": "getProfessionalRanking",
  "timestamp": "2026-06-12T18:42:00.000Z",
  "executionTimeMs": 4200,
  "cacheHit": false,
  "doctorCount": 12,
  "sessionCount": 3847,
  "paymentCount": 2156
}
```

Campos comuns:

- `executionTimeMs` — tempo total da operação.
- `cacheHit` — indica se o resultado veio do cache em memória.
- Contadores de entidades (`doctorCount`, `sessionCount`, `paymentCount`, `patientCount`, `issueCount`, etc.).

---

## Cache

- `/professionals/ranking`: **5 minutos** (adequado para dashboard administrativo).
- Lista de médicos ativos: **10 minutos**.
- Operações de reconciliação e fechamento **não usam cache** (dados sensíveis e mutáveis).

---

## Utilitário compartilhado

`back/utils/logMetric.js` centraliza o log de métricas:

- Emite JSON estruturado.
- Não lança exceções se o `console.log` falhar.
- Reutilizado por todos os serviços financeiros.

---

## Testes

`back/tests/unit/logMetric.test.js` cobre:

1. Emissão correta do JSON estruturado.
2. Resiliência a falhas do `console.log`.

Rodar:

```bash
cd back
npx vitest run tests/unit/logMetric.test.js
```

---

## Próximos passos (Sprint 4)

1. Página `/admin/professionals/results` com 5 abas ( Ranking, Resultado, Pacientes, Fechamentos, Saúde Financeira).
2. Reaproveitar `RankingProfissionais`, `ListaPacientesVIP`, `AlertsPanel`.
3. Paginação do ranking quando a clínica crescer (40+ profissionais, 50k+ sessões).

---

## Notas

- Regra de ouro mantida: **frontend não recalcula** produção, comissão, recebido ou saldo.
- Gargalo de performance é latência de rede com MongoDB Atlas; queries individuais estão indexadas.
