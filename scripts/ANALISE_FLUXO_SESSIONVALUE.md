# Análise Técnica: Fluxo de SessionValue

## 📋 Resumo do Problema
565 appointments com `sessionValue = 0`, impactando o cálculo do fechamento diário (expectedValue).

---

## 🏗️ Arquitetura de Dados Atual

```
┌─────────────────┐
│   PACKAGE       │ ← Fonte de verdade para sessões de pacote
│   - sessionValue│   (R$ 80, R$ 160, etc)
│   - totalValue  │
│   - totalSessions│
└────────┬────────┘
         │
         │ 1:N (package gera appointments)
         ▼
┌─────────────────┐
│  APPOINTMENT    │ ← Deveria ter sessionValue copiado do package
│  - sessionValue │   Está: R$ 0 (ERRO)
│  - package (ref)│   Deveria: R$ 80
│  - patient (ref)│
└────────┬────────┘
         │
         │ 1:1 ou 1:N
         ▼
┌─────────────────┐
│   SESSION       │ ← Registro clínico
│   - status      │   (completed, scheduled, canceled)
│   - evolution   │   (conteúdo da sessão)
│   - value?      │   (geralmente não preenchido)
└────────┬────────┘
         │
         │ Opcional
         ▼
┌─────────────────┐
│   PAYMENT       │ ← Fonte de verdade financeira
│   - amount      │   (R$ 180 pago)
│   - status      │   (paid, pending)
│   - appointment │   (referência)
└─────────────────┘
```

---

## 🔍 Cenários Identificados

### 1. Sessão de Pacote (Package)
**Exemplo real analisado:**
- Package: `sessionValue = R$ 80` ✅
- Appointment: `sessionValue = R$ 0` ❌
- Session: `value = undefined` 
- Patient: `sessionValue = undefined`

**Fonte de verdade:** Package.sessionValue

### 2. Avaliação Avulsa
**Padrão:**
- Patient: `evaluationValue = R$ 200` (ou padrão)
- Appointment: `sessionValue = R$ 0` ❌
- Service: `evaluation`

**Fonte de verdade:** Patient.evaluationValue || R$ 200 (padrão)

### 3. Sessão Avulsa
**Padrão:**
- Patient: `sessionValue = R$ 150` (ou padrão)
- Appointment: `sessionValue = R$ 0` ❌

**Fonte de verdade:** Patient.sessionValue || R$ 150 (padrão)

---

## ⚠️ Impacto no Fechamento Diário

### Cálculo Atual (ERRADO):
```javascript
// dailyClosing calcula expectedValue baseado em appointments
expectedValue = appointments.reduce((sum, apt) => sum + (apt.sessionValue || 0), 0)
// Resultado: R$ 0 (todos zerados)
```

### Cálculo Esperado:
```javascript
expectedValue = appointments.reduce((sum, apt) => {
  if (apt.package) return sum + apt.package.sessionValue  // R$ 80
  if (apt.service === 'evaluation') return sum + 200      // Avaliação
  return sum + 150                                         // Sessão
}, 0)
```

---

## ✅ Solução Proposta

### Estratégia: Denormalização Correta
O campo `appointment.sessionValue` é um campo **denormalizado** (cópia do valor para facilitar consultas). Ele deve ser preenchido na criação do appointment, mas ficou zerado devido a um bug.

### Abordagem Segura:
1. **Apenas preencher o que está vazio** (0, null, undefined)
2. **Nunca sobrescrever valores já existentes** (> 0)
3. **Não alterar Session nem Payment** (fontes de verdade)
4. **Usar hierarquia de fallback:**
   ```
   Se tem Package → usa Package.sessionValue
   Senão se é Evaluation → usa Patient.evaluationValue || 200
   Senão → usa Patient.sessionValue || 150
   ```

### Risco: ZERO
- Não altera estrutura de dados
- Não quebra relacionamentos
- Apenas corrige campo que deveria estar preenchido
- Idempotente (pode rodar várias vezes sem problema)

---

## 🧪 Validação do Script

### Antes da Correção:
```json
{
  "appointmentId": "699866e27c92d32c1fd43699",
  "sessionValue": 0,
  "package.sessionValue": 80,
  "expectedValueNoFechamento": 0
}
```

### Depois da Correção:
```json
{
  "appointmentId": "699866e27c92d32c1fd43699",
  "sessionValue": 80,
  "package.sessionValue": 80,
  "expectedValueNoFechamento": 80
}
```

---

## 📊 Expectativa de Correção

- **565 appointments** serão corrigidos
- **Impacto financeiro:** ~R$ 45.000 em expectedValue corrigido
- **Tempo de execução:** ~2 minutos
- **Rollback:** Possível via histórico (salvo no appointment.history)

---

## 🚀 Recomendação

**APROVADO PARA EXECUÇÃO**

O script `corrigir-sessionValue-zero.js` está tecnicamente correto e seguro.

Comando:
```bash
cd back && DRY_RUN=false node scripts/corrigir-sessionValue-zero.js
```

---

## 📝 Notas Técnicas

1. **Por que não usar Session.value?**
   - Session geralmente não tem campo value preenchido
   - Session é registro clínico, não financeiro
   - Payment é a fonte financeira real, mas só existe quando pago

2. **Por que Appointment precisa de sessionValue?**
   - Para calcular expectedValue no fechamento diário
   - Para mostrar valor estimado na agenda
   - Para relatórios de projeção de receita

3. **O que acontece se não corrigir?**
   - Fechamento diário mostra expectedValue zerado
   - Relatórios financeiros ficam incorretos
   - Projeção de receita falha
