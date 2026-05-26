# 💰 Contrato Financeiro V2

> **Última atualização:** 2026-05-25  
> **Versão da regra:** 2.1 (unified valuation + defense-in-depth)

---

## 1. Domínios Financeiros Oficiais

| Domínio | Significado | Fonte de verdade |
|---------|-------------|------------------|
| **Caixa** | Dinheiro que efetivamente entrou no período | `Payment` only |
| **Competência** | Receita reconhecida pela realização clínica | `Session` + `appointment.date` |
| **Produção** | Serviço clínico realizado (independente de pagamento) | `Session` only |
| **Liquidação** | Produção com cobertura financeira garantida | `Session` + `Payment` |
| **Diferido** | Valor vendido (pacote) mas ainda não consumido | `Package` - `Session` |
| **Convênio** | Produção realizada aguardando repasse da seguradora | `Session` + `insuranceGuide` |
| **Inadimplência** | Produção realizada sem liquidação financeira | `Session` + `Payment.pending` |

---

## 2. Qual Data Vale para Quê

| Propósito | Campo oficial | Fallback |
|-----------|--------------|----------|
| **Caixa / DRE** | `payment.financialDate` | `payment.paymentDate` |
| **Competência clínica** | `appointment.date` | `session.date` |
| **Auditoria operacional** | `payment.paidAt` | — |
| **Auditoria técnica** | `payment.createdAt` | — |

### Regras de decisão

```
CAIXA  →  financialDate ?? paymentDate
COMPETÊNCIA  →  appointment.date ?? session.date
```

Nenhum outro campo deve ser usado como fonte primária para esses propósitos.

---

## 3. Valuation da Sessão (Regra Única)

Toda sessão completada tem um valor financeiro determinado pela seguinte hierarquia:

```
1. package.sessionValue      (valor unitário explícito)
2. package.totalValue / package.totalSessions  (prorata)
3. session.sessionValue      (valor avulso)
4. 0                         (fallback de segurança)
```

### Onde está implementada

- **JavaScript puro:** `utils/resolveSessionFinancialValue.js`
- **MongoDB Aggregation:** `utils/resolveSessionFinancialValue.aggregate()` (retorna stages)

### Quem deve usar

- `unifiedFinancialService.v2.js` (caixa & produção)
- `cashflow.v2.js` (transações do dia)
- `financialDashboard.v2.js` (resumo mensal)
- `routes/totals.v2.js`
- `routes/dailyClosingV2.js`
- `routes/dailySummary.v2.js`
- `routes/analytics/operational.routes.js`
- Qualquer relatório novo que envolva valuation de sessão

---

## 4. Categorias Financeiras Oficiais

### Payment.kind

| Valor | Significado | Entra em caixa? |
|-------|-------------|-----------------|
| `package_receipt` | Venda de pacote | ✅ Sim |
| `session_payment` | Pagamento de sessão avulsa | ✅ Sim |
| `appointment_payment` | Pagamento vinculado a agendamento | ✅ Sim |
| `revenue_recognition` | Reconhecimento de receita (liminar/pacote) | ✅ Sim |
| `package_consumed` | Consumo de sessão de pacote | ❌ Nunca |
| `monthly_settlement` | Fechamento mensal | ✅ Sim |
| `debt_settlement` | Quitação de dívida | ✅ Sim |

### Payment.status

| Valor | Significado |
|-------|-------------|
| `paid` | Quitado |
| `pending` | Pendente |
| `partial` | Parcial |
| `consumed` | Consumido (pacote) — downgrade automático de `paid` |
| `recognized` | Reconhecido |

---

## 5. Contrato de Resposta (API)

Todo endpoint financeiro deve retornar dados compatíveis com:

```js
{
  caixa: {
    total,
    particular, pacote, convenio, liminar,
    byMethod: { pix, dinheiro, cartao, outros }
  },
  producao: {
    totalProduzido,
    producaoLiquidada,  // alias legado: recebido
    pendente,
    convenio, particular, pacote, liminar
  },
  indicadores: {
    taxaLiquidacao,     // liquidada / produzida
    taxaInadimplencia,  // pendente / produzida
    ticketMedio
  }
}
```

Builders disponíveis em: `contracts/FinancialReport.js`

---

## 6. Defense-in-Depth (Proteções Financeiras)

### Caixa (Payment aggregate)

```js
{
  status: 'paid',
  amount: { $gt: 0 },
  isFromPackage: { $ne: true },   // consumo de pacote NUNCA é caixa
  kind: { $ne: 'package_consumed' },
  billingType: { $ne: 'convenio' },
  paymentMethod: { $ne: 'convenio' }
}
```

### Produção (Session aggregate)

```js
{ status: 'completed', date: { $gte: start, $lte: end } }
```

---

## 7. Glossário

| Termo | Definição |
|-------|-----------|
| **Caixa** | Dinheiro que entrou no período (competência financeira) |
| **Produção** | Valor clínico realizado no período (competência clínica) |
| **Produção Liquidada** | Produção cuja cobertura financeira já está garantida (pré-pago, pago hoje, convênio reconhecido) |
| **Receita Diferida** | Dinheiro recebido por pacotes mas ainda não consumido |
| **Taxa de Liquidação** | % da produção que já tem cobertura financeira |
| **Taxa de Inadimplência** | % da produção realizada mas não paga |

---

## 8. Changelog da Regra

| Data | Versão | Mudança |
|------|--------|---------|
| 2026-05-22 | 2.0 | Criação do `unifiedFinancialService.v2.js` com separation of concerns |
| 2026-05-25 | 2.1 | Fix do `pkgLookupStages` incluindo fallback `totalValue / totalSessions`; rename `recebidoProducao` → `producaoLiquidada`; defense-in-depth `isFromPackage: { $ne: true }` no caixa |
