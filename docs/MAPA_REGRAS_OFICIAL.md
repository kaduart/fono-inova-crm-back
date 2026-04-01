# MAPA OFICIAL DE REGRAS DO SISTEMA
## Baseado nas confirmações do documento-analise.txt

---

## ✅ REGRAS CONFIRMADAS PELO USUÁRIO

### 1️⃣ AGENDAMENTO

**Regra A1: Criação do compromisso**
- Pode agendar SEM pagamento: ✅ SIM
- Ao criar agendamento:
  - Hoje cria: Appointment + Session + Payment (trinca)
  - Status inicial: `pending` (ou `scheduled`)
- Secretaria vai no calendário e marca como confirmado
- Secretaria informa: "pago antes", "pagará depois" ou "pacote"

**Regra A2: Conflito de horário**
- NÃO pode existir 2 agendamentos no mesmo slot
- Status `cancelled` libera o horário ✅

**Regra A3: Confirmação**
- A secretaria confirma manualmente
- Não é automático

---

### 2️⃣ PACOTE DE SESSÕES

**Regra P1: Consumo de sessão**
- Sessão NÃO é consumida no agendamento ❌
- Sessão só é consumida quando: ✅ "a sessão é realizada" (completed)
- Se pacote pago antecipadamente: só dá baixa no complete

**Regra P2: O que acontece no complete**
- Se tiver pacote → baixa sessão
- Se já pago → apenas registra

---

### 3️⃣ PAGAMENTO

**Regra PG1: Momento do pagamento**
- Pode ocorrer: ✅ antes, depois, ou ambos (depende)
- Pagamento é: ✅ "consequência da execução (sessão), não do agendamento"

**Regra PG2: Criação**
- Hoje: cria Payment no agendamento (junto com Session)
- Ideal: criar só no complete (a ser avaliado)

**Regra PG3: Vinculação**
- Pagamento está ligado a: appointment e sessão
- Fluxo gera/atualiza pagamento na execução

---

### 4️⃣ CONVÊNIO

**Regra C1: Validação de guia**
- Depende do caso
- Pode validar antes ou depois (flexível)

---

### 5️⃣ CANCELAMENTO

**Regra CC1: Liberação**
- Libera horário: ✅ SIM
- Libera sessão do pacote: não confirmado (pode variar)

---

## 🎯 FLUXOS REAIS CONFIRMADOS

### Fluxo 1: Agendamento (hoje)
```
1. Criar agendamento
   → Cria: Appointment
   → Cria: Session (já!)  
   → Cria: Payment (já!)
   → Status: pending/scheduled
   → NÃO exige pagamento na criação

2. Secretaria confirma
   → Marca: "pago antes", "pagará depois" ou "pacote"
   → Status: confirmed

3. Sessão realizada (/complete)
   → Se pacote → baixa sessão
   → Se não pago → gera cobrança
   → Se pago → registra como quitado
```

### Fluxo 2: Cancelamento
```
1. Cancelar agendamento
   → Status = cancelled
   → Libera horário
   → NÃO consome sessão
```

---

## 🧠 REGRA DE OURO DO SISTEMA

> **"Agendamento ≠ Pagamento"**
> 
> **"Pagamento é consequência da execução (sessão), não do agendamento"**

---

## ⚠️ PONTO DE ATENÇÃO (DECISÃO ARQUITETURAL)

### Opção 1: Como está hoje (mantém compatibilidade 100%)
```
Agendamento cria:
- Appointment ✅
- Session ✅
- Payment ✅
```

**Vantagens:**
- Compatível com sistema atual
- Menos mudanças

**Problemas:**
- Cria dados "prematuros"
- Session e Payment existem antes da execução

---

### Opção 2: Melhoria (recomendada para nova arquitetura)
```
Agendamento cria:
- Appointment ✅

Complete cria:
- Session ✅
- Payment ✅ (se necessário)
```

**Vantagens:**
- Coerente com regra "pagamento é consequência"
- Menos inconsistência
- Mais flexível

**Desafio:**
- Muda comportamento atual
- Requer migração de dados

---

## 📋 DECISÃO DO USUÁRIO

O usuário precisa decidir:

> **"Mantenho a trinca (Appointment+Session+Payment) no agendamento como está hoje, ou melhoramos para criar só no complete?"**

---

## ✅ IMPLEMENTAÇÃO RECOMENDADA

Para a nova arquitetura event-driven, sugiro:

### Fase 1 (compatibilidade):
Manter comportamento atual (trinca no agendamento)

### Fase 2 (melhoria):
Migrar para criar Session+Payment só no complete

Isso permite:
1. Testar event-driven sem mudar regras
2. Migrar gradualmente
3. Validar comportamento antes de otimizar

---

**Documento gerado por análise de:** `back/logs-archive/documento-analise.txt`
**Regras confirmadas pelo usuário nas linhas:** 730, 877, 981-986
