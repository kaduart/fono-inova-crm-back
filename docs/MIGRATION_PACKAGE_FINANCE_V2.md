# 🎯 MIGRAÇÃO PACOTE → FINANCEIRO V2 (PLANO DE PRODUÇÃO)

## 📊 O QUE JÁ EXISTE (NÃO REINVENTAR)

### ✅ Modelo de Pacote (Legado V2 já tem)
```
Package (Source of Truth)
├── totalSessions, sessionsDone
├── totalValue, totalPaid, balance
├── type: 'therapy' | 'convenio' | 'liminar'
└── status: 'active' | 'finished' | 'canceled'
```

### ✅ CQRS para Leitura (Já existe)
```
PackagesView (Read Model)
├── totalSessions, sessionsUsed, sessionsRemaining
├── totalValue, totalPaid, balance
├── sessions: [...] // resumo denormalizado
└── snapshot: { version, calculatedAt, ttl }
```

### ✅ Eventos (Já publicados)
- `PACKAGE_CREATED` → filas: package-projection, package-validation
- `INSURANCE_PACKAGE_CREATED` → pacotes de convênio

### ✅ Workers (Já rodando)
- `packageProjectionWorker` → atualiza PackagesView
- `packageValidationWorker` → validações de negócio

---

## 🎯 O QUE PRECISAMOS ADICIONAR (MIGRAÇÃO LIMPA)

### 1. Eventos Novos (Só se não existirem)

Verificar se já existe:
- `PACKAGE_SESSION_CONSUMED` - quando sessão consome pacote
- `PACKAGE_EXPIRED` - quando pacote vence

Se NÃO existir, adicionar no `eventPublisher.js`:
```javascript
PACKAGE_SESSION_CONSUMED: 'PACKAGE_SESSION_CONSUMED',
PACKAGE_EXPIRED: 'PACKAGE_EXPIRED'
```

### 2. Aggregate no Totals V2 (Usar PackagesView)

**Abordagem recomendada:** Ler do `PackagesView` (já otimizado)

```javascript
// No totals.v2.js e totalsWorker.js
const packageStats = await PackagesView.aggregate([
  { $match: { status: { $in: ['active', 'finished'] } } },
  {
    $group: {
      _id: null,
      // Crédito total (receita diferida)
      totalRemainingAmount: { $sum: '$sessionsRemaining' }, // em sessões
      totalRemainingValue: { 
        $sum: { $multiply: ['$sessionsRemaining', '$sessionValue'] }
      },
      // Já consumido (produção realizada via pacote)
      totalUsedAmount: { $sum: '$sessionsUsed' },
      totalUsedValue: {
        $sum: { $multiply: ['$sessionsUsed', '$sessionValue'] }
      },
      // Totais
      totalSold: { $sum: '$totalValue' },
      totalPaid: { $sum: '$totalPaid' },
      activePackages: { $sum: 1 }
    }
  }
]);
```

### 3. Estrutura no Retorno do Totals

```javascript
totals: {
  // ... existing fields ...
  
  // 📦 PACOTE - Receita Diferida
  packageCredit: {
    // Dinheiro já recebido mas não produzido (obrigação)
    deferredRevenue: number,      // 💰 totalRemainingValue
    deferredSessions: number,     // 📊 totalRemainingAmount (em sessões)
    
    // Já produzido via pacote
    recognizedRevenue: number,    // 📊 totalUsedValue
    recognizedSessions: number,   // 📊 totalUsedAmount
    
    // Totais
    totalSold: number,            // 💰 totalSold
    totalPaid: number,            // 💰 totalPaid
    activePackages: number        // 📦 activePackages
  }
}
```

---

## ⚠️ REGRAS CRÍTICAS (NÃO QUEBRAR)

### 1. Produção = Sessão Realizada (independente de pagamento)
```
Particular → payment.status = 'paid'
Pacote → session consome pacote (sessionsUsed++)
Convênio → session.status = 'completed' + insurance billing
```

### 2. Caixa = Dinheiro que Entrou
```
Particular → payment criado e pago
Pacote → payment do pacote (totalPaid)
Convênio → insurance recebido
```

### 3. NUNCA Misturar
❌ Não somar pacote em `totalPending` (já foi pago)
❌ Não somar pacote em `totalReceived` duas vezes
✅ Pacote é `deferredRevenue` (receita diferida)

---

## 🔄 FLUXO EVENT-DRIVEN (IDEAL)

```
┌─────────────────┐
│ Session Created │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Tem Pacote?    │────Não────┐
└────────┬────────┘           │
         │ Sim                │
         ▼                    │
┌─────────────────┐           │
│ consumePackage  │           │
│   Session()     │           │
└────────┬────────┘           │
         │                    │
         ▼                    ▼
┌─────────────────┐    ┌─────────────────┐
│ PACKAGE_SESSION │    │  BILLING_NORMAL │
│   _CONSUMED     │    │   (particular)  │
└────────┬────────┘    └─────────────────┘
         │
         ▼
┌─────────────────┐
│  Atualiza View  │
│ PackagesView    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Totals V2 lê   │
│  da View (CQRS) │
└─────────────────┘
```

---

## 🚀 IMPLEMENTAÇÃO PASSO A PASSO

### FASE 1: Preparação (Read Only)
1. ✅ Verificar se PackagesView está populado
2. ✅ Criar aggregate de leitura no Totals V2
3. ✅ Comparar com legado (sem ativar)

### FASE 2: Integração
1. Adicionar `packageCredit` no retorno do `/v2/totals`
2. Adicionar mesmo no `totalsWorker.js`
3. Atualizar `TotalsSnapshot` schema

### FASE 3: Validação
1. Dashboard paralelo: legado vs V2
2. Conferir: `totalProduction = particular + convenio + pacote_usado`
3. Conferir: `totalReceived = particular_pago + convenio_recebido + pacote_pago`

### FASE 4: Eventos (Se necessário)
1. Adicionar `PACKAGE_SESSION_CONSUMED` se não existir
2. Criar worker para atualizar TotalsSnapshot em tempo real

---

## 🎯 DECISÕES TOMADAS

| Decisão | Escolha | Motivo |
|---------|---------|--------|
| Ler Package ou PackagesView? | **PackagesView** | Já otimizado, CQRS, índices prontos |
| Aggregate em tempo real? | **Sim (fallback)** | Simplifica, sem cache stale |
| Eventos para atualização? | **Fase 2** | Só se performance exigir |
| Campo no snapshot? | **Sim** | Consistência histórica |

---

## 📋 CHECKLIST IMPLEMENTAÇÃO

- [ ] Verificar se `PACKAGE_SESSION_CONSUMED` existe
- [ ] Criar aggregate usando `PackagesView`
- [ ] Atualizar `totals.v2.js`
- [ ] Atualizar `totalsWorker.js`
- [ ] Atualizar `TotalsSnapshot` schema
- [ ] Testar com dados reais
- [ ] Comparar com legado
- [ ] Documentar divergências (se houver)

---

## 💡 NOTAS

> **IMPORTANTE:** Não criar `PatientPackage` novo. Usar `Package` existente + `PackagesView`.

> **IMPORTANTE:** Não modificar lógica de consumo. Usar `consumePackageSession.js` existente.

> **IMPORTANTE:** Não criar eventos novos se já tiver `PACKAGE_CREATED` e `SESSION_COMPLETED`.
