# 📊 RELATÓRIO: GAP Analysis - Legado vs 4.0

> **Data:** 2025-04-01  
> **Analisado por:** Kimi Code  
> **Objetivo:** Identificar gaps entre o fluxo LEGADO e a versão 4.0 (Event-Driven)

---

## 🎯 RESUMO EXECUTIVO

```
┌─────────────────────────────────────────────────────────────────────┐
│                    COBERTURA DA VERSÃO 4.0                          │
├─────────────────────────────────────────────────────────────────────┤
│  ✅ PARTICULAR Avulso          - 80% (falta: compensação)           │
│  ⚠️  PACOTE Therapy (pré-pago) - 60% (falta: reaproveitamento)      │
│  ❌ PACOTE Per-Session         - 30% (falta: atualização totalPaid) │
│  ❌ PACOTE Convênio            - 20% (falta: consumo de guia)       │
│  ❌ PACOTE Liminar             - 10% (falta: reconhecimento receita)│
│  ✅ FIADO (Add to Balance)     - 90% (implementado)                 │
│  ❌ CANCELAMENTO               - 0%  (não existe na 4.0)            │
│  ❌ REAGENDAMENTO              - 0%  (não existe na 4.0)            │
└─────────────────────────────────────────────────────────────────────┘
```

**Status Geral:** A 4.0 implementa ~40% das regras complexas do legado.

---

## 🔍 ANÁLISE DETALHADA POR FLUXO

### 1️⃣ FLUXO: Particular Avulso (Sem Pacote)

#### Legado (appointment.js linhas 1608-1773)
```javascript
// Regras implementadas:
✅ Cria Session com status 'completed'
✅ isPaid: true
✅ paymentStatus: 'paid'
✅ visualFlag: 'ok'
✅ Cria Payment fora da transação
✅ Vincula Payment ao Appointment
✅ Compensação se falhar (cancela Payment)
```

#### 4.0 (completeSessionEventService.js)
```javascript
// Regras implementadas:
✅ Atualiza Session → completed
✅ isPaid: true
✅ paymentStatus: 'paid'
✅ Publica evento PAYMENT_REQUESTED

// FALTANDO:
❌ Criação real do Payment (só publica evento)
❌ Vinculação Payment ↔ Appointment
❌ Confirmação do Payment após commit
❌ Compensação se transação falhar
```

**Gap:** O Payment não é criado sincronamente. O worker `paymentWorker.js` processa, mas ele foi projetado para o fluxo de CRIAÇÃO de agendamento, não para o COMPLETE.

---

### 2️⃣ FLUXO: Pacote Therapy (Pré-pago - amount <= 0)

#### Legado (appointment.js linhas 227-475)
```javascript
// CRIAÇÃO - Regras:
✅ Busca sessão cancelada paga (canceledPaidSession)
✅ Reaproveita crédito: isPaid=true, partialAmount=valor
✅ Se não encontrar: nova sessão isPaid=false
✅ NÃO cria Payment (usa crédito existente)

// COMPLETE - Regras:
✅ Atualiza Session → completed
✅ sessionsDone++ no pacote
✅ Calcula comissão
```

#### 4.0
```javascript
// packageValidationWorker.js (CRIAÇÃO)
✅ Valida se pacote tem crédito
✅ Cria Session vinculada
✅ Incrementa sessionsDone

// FALTANDO NA CRIAÇÃO:
❌ Reaproveitamento de sessão cancelada
❌ Preservação de dados em 'original*'
❌ Cálculo de partialAmount

// FALTANDO NO COMPLETE:
❌ Cálculo de comissão (commissionRate * sessionValue)
```

**Gap Crítico:** O reaproveitamento de sessões canceladas é uma regra de negócio importante que não existe na 4.0.

---

### 3️⃣ FLUXO: Pacote Per-Session (Paga por sessão)

#### Legado (appointment.js linhas 1709-1736, 1839-1867)
```javascript
// Regras no COMPLETE:
✅ Cria Payment FORA da transação (evita write conflict)
✅ Payment.status começa como 'pending'
✅ Atualiza Package:
│   ├── totalPaid += sessionValue
│   ├── paidSessions++
│   ├── balance = totalValue - totalPaid
│   └── financialStatus = recalculado
✅ Session.isPaid = true
✅ Vincula Payment ao Appointment
✅ Confirma Payment após commit (pending → paid)
```

#### 4.0
```javascript
// Regras implementadas:
✅ Determina paymentOrigin = 'auto_per_session'
✅ Publica evento PAYMENT_REQUESTED

// FALTANDO:
❌ Atualização de Package.totalPaid
❌ Atualização de Package.paidSessions
❌ Recálculo de Package.financialStatus
❌ Criação síncrona do Payment (com status pending)
❌ Vinculação Payment ↔ Appointment
❌ Confirmação assíncrona do Payment
```

**Gap Crítico:** A 4.0 não atualiza o estado financeiro do pacote no per-session. Isso é essencial para relatórios.

---

### 4️⃣ FLUXO: Pacote Convênio

#### Legado (appointment.js linhas 2165-2237)
```javascript
// Regras no COMPLETE:
✅ Consome guia de convênio (guide.usedSessions++)
✅ Se guia esgotou: guide.status = 'exhausted'
✅ Cria Payment com billingType='convenio'
✅ Payment.status = 'pending'
✅ Payment.insuranceValue = valor do convênio
✅ Session.paymentStatus = 'pending_receipt'
✅ Atualiza package.insuranceGrossAmount
```

#### 4.0
```javascript
// Regras implementadas:
✅ Determina paymentOrigin = 'convenio'
✅ Session.paymentStatus = 'pending_receipt' (no buildSessionUpdate)

// FALTANDO:
❌ Consumo da guia de convênio
❌ Verificação se guia está ativa/esgotada
❌ Criação do Payment de convênio
❌ Atualização do package com insuranceGrossAmount
```

**Gap Crítico:** O consumo da guia não existe na 4.0. Isso pode causar inconsistências no faturamento.

---

### 5️⃣ FLUXO: Pacote Liminar (Judicial)

#### Legado (appointment.js linhas 2113-2162)
```javascript
// Regras no COMPLETE:
✅ Reconhece receita:
│   ├── package.liminarCreditBalance -= sessionValue
│   ├── package.recognizedRevenue += sessionValue
│   └── package.totalPaid += sessionValue
✅ Cria Payment:
│   ├── kind: 'revenue_recognition'
│   ├── paymentMethod: 'liminar_credit'
│   ├── billingType: 'particular'
│   └── status: 'paid'
✅ Vincula Payment ao Appointment
```

#### 4.0
```javascript
// Regras implementadas:
✅ Determina paymentOrigin = 'liminar'

// FALTANDO:
❌ Reconhecimento de receita (liminarCreditBalance, recognizedRevenue)
❌ Criação do Payment de revenue_recognition
❌ Vinculação ao Appointment
```

**Gap:** Receita liminar não é reconhecida na 4.0.

---

### 6️⃣ FLUXO: Fiado (Add to Balance)

#### Legado (appointment.js linhas 1780-1788, 2275-2290)
```javascript
✅ Session.isPaid = false
✅ Session.paymentStatus = 'pending'
✅ Session.visualFlag = 'pending'
✅ Session.addedToBalance = true
✅ Appointment.paymentStatus = 'pending'
✅ PatientBalance.addDebit() (fora da transação)
```

#### 4.0
```javascript
✅ Implementado em buildSessionUpdate()
✅ Implementado em buildAppointmentUpdate()
✅ Publica evento BALANCE_UPDATE_REQUESTED
✅ BalanceWorker processa com atomic $inc
```

**Status:** ✅ 90% implementado. Só falta o cálculo de comissão (que no legado é 0 para fiado).

---

### 7️⃣ FLUXO: Cancelamento

#### Legado (appointment.js linhas 1423-1605)
```javascript
✅ Preserva dados em 'original*' (originalPartialAmount, originalPaymentStatus, etc)
✅ Marca Session como 'canceled'
✅ Payment → status: 'canceled' (se não for de pacote)
✅ Session.sessionConsumed = false (estorna consumo)
✅ Reversão de comissão (commissionValue = 0)
```

#### 4.0
```javascript
// FALTANDO COMPLETAMENTE:
❌ Não existe endpoint de cancelamento na 4.0
❌ Não existe lógica de preservação de dados
❌ Não existe compensação/reversão
```

**Gap Crítico:** Cancelamento não existe na 4.0.

---

### 8️⃣ FLUXO: Reagendamento (Reaproveitamento)

#### Legado (appointment.js linhas 289-336)
```javascript
✅ Busca sessão cancelada com crédito
✅ Reaproveita: isPaid=true, partialAmount=originalPartialAmount
✅ Zera campos 'original*' da sessão antiga
```

#### 4.0
```javascript
// FALTANDO:
❌ Não existe lógica de reaproveitamento
```

---

## 📋 MATRIZ DE GAPS

| Funcionalidade | Legado | 4.0 | Status | Prioridade |
|----------------|--------|-----|--------|------------|
| **CRIAÇÃO** |
| Criar Appointment + Session | ✅ | ✅ | ✅ OK | - |
| Criar Payment (particular) | ✅ | ⚠️ Parcial | 🟡 Médio | P1 |
| Reaproveitar sessão cancelada | ✅ | ❌ | 🔴 Alto | P0 |
| **COMPLETE - Particular** |
| Criar Payment | ✅ | ❌ | 🔴 Alto | P0 |
| Vincular Payment | ✅ | ❌ | 🔴 Alto | P0 |
| Compensação | ✅ | ❌ | 🟡 Médio | P2 |
| **COMPLETE - Pacote Therapy** |
| Consumir sessão (sessionsDone++) | ✅ | ✅ | ✅ OK | - |
| Calcular comissão | ✅ | ❌ | 🟡 Médio | P2 |
| **COMPLETE - Per-Session** |
| Atualizar Package.totalPaid | ✅ | ❌ | 🔴 Alto | P0 |
| Atualizar Package.paidSessions | ✅ | ❌ | 🔴 Alto | P0 |
| Recalcular financialStatus | ✅ | ❌ | 🔴 Alto | P0 |
| Criar Payment | ✅ | ❌ | 🔴 Alto | P0 |
| **COMPLETE - Convênio** |
| Consumir guia de convênio | ✅ | ❌ | 🔴 Alto | P0 |
| Criar Payment de convênio | ✅ | ❌ | 🔴 Alto | P0 |
| Atualizar insuranceGrossAmount | ✅ | ❌ | 🟡 Médio | P2 |
| **COMPLETE - Liminar** |
| Reconhecer receita | ✅ | ❌ | 🔴 Alto | P0 |
| Criar Payment revenue_recognition | ✅ | ❌ | 🔴 Alto | P0 |
| **CANCELAMENTO** |
| Preservar dados em 'original*' | ✅ | ❌ | 🔴 Alto | P0 |
| Estornar consumo de pacote | ✅ | ❌ | 🔴 Alto | P0 |
| Cancelar Payment | ✅ | ❌ | 🔴 Alto | P0 |

---

## 🚨 PROBLEMAS CRÍTICOS IDENTIFICADOS

### 1. Payment Worker Não Atende ao Complete
**Arquivo:** `workers/paymentWorker.js`  
**Problema:** O worker foi projetado para processar `PAYMENT_REQUESTED` na CRIAÇÃO do agendamento (estado 'pending'). No COMPLETE, o agendamento já está 'scheduled' ou 'confirmed', então o State Guard do worker rejeita:

```javascript
// paymentWorker.js linha 98
if (appointment.operationalStatus === 'confirmed') {
    return { status: 'already_confirmed' }; // ❌ Retorna sem criar Payment!
}
```

**Impacto:** Pagamentos de per-session, convênio e particular não são criados no complete.

**Solução:** Criar um worker separado `completePaymentWorker.js` ou ajustar o state guard.

---

### 2. Package Validation Worker Consome Sessão na Criação
**Arquivo:** `workers/packageValidationWorker.js`  
**Problema:** O worker incrementa `sessionsDone` na CRIAÇÃO do agendamento:

```javascript
// packageValidationWorker.js linha 83-86
await Package.findByIdAndUpdate(packageId, {
    $inc: { sessionsDone: 1 }  // ❌ Incrementa na criação!
});
```

**Legado:** Só incrementa no COMPLETE.

**Impacto:** Se o paciente agendar e cancelar, a sessão já foi consumida.

**Solução:** Remover o incremento do packageValidationWorker e deixar só no complete.

---

### 3. Falta de Compensação na 4.0
**Problema:** Se o complete falhar após o commit, não há compensação.

**Legado:** Tem compensação que cancela o Payment:
```javascript
// appointment.js linhas 2339-2357
if (perSessionPayment && perSessionPayment._id) {
    await Payment.updateOne({ _id: perSessionPayment._id }, {
        status: 'canceled',
        cancellationReason: 'transaction_rollback'
    });
}
```

**Solução:** Implementar Saga Pattern no complete.

---

### 4. Comissão Não Calculada
**Problema:** A 4.0 não calcula `commissionValue` no complete.

**Legado:** Calcula no hook da Session:
```javascript
if (status === 'completed' && commissionRate && sessionValue) {
    commissionValue = sessionValue * commissionRate;
}
```

---

## 💡 RECOMENDAÇÕES

### Curto Prazo (1-2 semanas)
1. **Corrigir o Payment Worker** para atender ao complete
2. **Criar worker de Convênio** para consumir guia
3. **Criar worker de Liminar** para reconhecer receita
4. **Ajustar PackageValidationWorker** para não consumir sessão na criação

### Médio Prazo (1 mês)
1. Implementar **Cancelamento** na 4.0
2. Implementar **Reaproveitamento** de sessões canceladas
3. Implementar **cálculo de comissão**
4. Adicionar **compensação** (Saga Pattern)

### Longo Prazo (2-3 meses)
1. Testes E2E cobrindo todos os cenários
2. Migração gradual: 10% → 50% → 100% de tráfego
3. Monitoramento e alertas

---

## 📁 ARQUIVOS QUE PRECISAM SER CRIADOS/MODIFICADOS

### Novos Workers
```
workers/
├── completePaymentWorker.js      # Payment no complete (per-session, convenio, etc)
├── insuranceWorker.js            # Consumo de guia de convênio
├── liminarRevenueWorker.js       # Reconhecimento de receita liminar
├── commissionWorker.js           # Cálculo de comissão
└── cancelWorker.js               # Processamento de cancelamento
```

### Modificações
```
services/
├── completeSessionEventService.js    # Adicionar cálculo de comissão
└── completeSessionOutboxService.js   # Adicionar eventos faltantes

workers/
├── packageValidationWorker.js        # Remover incremento de sessionsDone
└── paymentWorker.js                  # Ajustar state guard
```

---

## ✅ CHECKLIST PARA MVP DA 4.0

Antes de colocar a 4.0 em produção, garantir:

- [ ] Per-Session atualiza Package.totalPaid
- [ ] Convênio consome guia
- [ ] Liminar reconhece receita
- [ ] Comissão é calculada
- [ ] Cancelamento funciona
- [ ] Reaproveitamento de sessão cancelada funciona
- [ ] Compensação em caso de falha
- [ ] Testes E2E passando

---

## 📞 CONCLUSÃO

A versão 4.0 tem uma **arquitetura sólida** (Event-Driven, Outbox Pattern, Workers) mas **falta implementar as regras de negócio complexas** do legado.

**Recomendação:** Não migrar 100% para a 4.0 ainda. Usar **Feature Flags** para rotear tráfego:
- Particular simples → 4.0
- Pacote comum → 4.0
- Per-session, Convênio, Liminar → Legado

Assim você vai para produção gradualmente sem quebrar o financeiro.

---

**Fim do Relatório**
