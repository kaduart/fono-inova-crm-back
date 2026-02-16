# 📋 FASE 3 - PLANO DE IMPLEMENTAÇÃO
**Orchestrator Intelligence usando Detectores Contextuais**

---

## 🎯 Objetivo

Utilizar as detecções contextuais da FASE 1 e FASE 2 para tomar decisões inteligentes no `AmandaOrchestrator`, gerando respostas mais precisas e personalizadas.

---

## 📊 Estado Atual

### Detectores Disponíveis (FASE 1 + FASE 2)

✅ **ConfirmationDetector** - Detecta nuances em confirmações
✅ **InsuranceDetector** - Detecta planos de saúde específicos
✅ **PriceDetector** - Detecta 5 tipos de perguntas sobre preço
✅ **SchedulingDetector** - Detecta 4 tipos + urgência + período

### Uso Atual no Orchestrator

```javascript
// linha 615 - AmandaOrchestrator.js
const flags = detectWithContextualDetectors(text, lead, enrichedContext);

// linha 619-632 - Apenas LOGS, sem ação
if (flags._confirmation) {
  console.log("✅ [CONFIRMATION] Detecção contextual:", { ... });
}
if (flags._insurance) {
  console.log("🏥 [INSURANCE] Detecção contextual:", { ... });
}

// ❌ _price e _scheduling NÃO são utilizados!
```

**Problema:** Os detectores da FASE 2 (Price e Scheduling) não influenciam as respostas.

---

## 🚀 FASE 3 - Estratégias de Implementação

### 1. 💰 PriceDetector Intelligence

#### 1.1. Detecção de Objeção de Preço

**Cenário atual:**
```javascript
Lead: "o preço tá muito caro"
Sistema: Responde com preço genérico ou AI fallback
```

**Com FASE 3:**
```javascript
if (flags._price?.priceType === 'objection') {
  // Estratégia anti-objeção
  return buildPriceObjectionResponse({
    therapyArea: lead.therapyArea,
    objectionType: flags._price.priceType,
    hasObjection: flags._price.hasObjection
  });
}
```

**Resposta estratégica:**
```
Entendo sua preocupação! 💚 O valor da avaliação (R$ 200) já inclui:
✓ Avaliação completa (60-90min)
✓ Relatório detalhado
✓ Orientações personalizadas
✓ Plano terapêutico

E se precisar continuar o tratamento, temos pacote mensal de R$ 720 (4 sessões),
que sai mais em conta que fazer avulso. Quer ver os horários disponíveis?
```

#### 1.2. Detecção de Negociação

**Cenário:**
```javascript
Lead: "tem desconto no preço?"
```

**Estratégia:**
```javascript
if (flags._price?.priceType === 'negotiation') {
  return buildNegotiationResponse({
    wantsDiscount: /desconto/i.test(text),
    wantsInstallment: /parcelar/i.test(text),
    therapyArea: lead.therapyArea
  });
}
```

**Resposta:**
```
Para a avaliação (R$ 200) o pagamento é à vista, mas **se você fechar o pacote
mensal** (R$ 720), conseguimos parcelar em até **2x sem juros** no cartão! 💳

Quer que eu já te passe os horários disponíveis para agendar?
```

#### 1.3. Detecção de Insistência

**Cenário:**
```javascript
Lead já perguntou preço antes, Amanda respondeu, lead pergunta de novo
Context: { priceAlreadyMentioned: true }
Lead: "só o preço"
```

**Estratégia:**
```javascript
if (flags._price?.isInsistent && flags._price?.alreadyMentioned) {
  // Lead não está convencido, precisa de valor adicional
  return buildValuePitchResponse({
    therapyArea: lead.therapyArea,
    previouslyMentioned: true
  });
}
```

**Resposta:**
```
Como mencionei, são R$ 200 pela avaliação completa 😊

Só pra você ter certeza: essa avaliação é super detalhada, você sai com um
**relatório por escrito** + **plano personalizado** que pode inclusive levar
para outros profissionais se quiser uma segunda opinião.

Quer marcar? Tenho vagas essa semana!
```

#### 1.4. Detecção de Comparação

**Cenário:**
```javascript
Lead: "achei outra clínica com preço mais barato"
```

**Estratégia:**
```javascript
if (flags._price?.priceType === 'comparison') {
  return buildCompetitiveResponse({
    therapyArea: lead.therapyArea,
    hasObjection: true
  });
}
```

**Resposta:**
```
Entendo! 💚 É sempre bom comparar mesmo. Aqui na Fono Inova o diferencial é:

🎯 Equipe **multidisciplinar** (se precisar de outras áreas, já estamos integrados)
📋 **Relatório completo** por escrito
🏥 Clínica estruturada e referência em Anápolis há 10+ anos
⭐ +500 famílias atendidas

O investimento é R$ 200, mas a qualidade do atendimento compensa. Quer experimentar?
```

---

### 2. 📅 SchedulingDetector Intelligence

#### 2.1. Detecção de Urgência

**Cenário:**
```javascript
Lead: "preciso agendar urgente, hoje se possível"
```

**Estratégia:**
```javascript
if (flags._scheduling?.hasUrgency) {
  // Priorizar slots do mesmo dia ou próximos dias
  const urgentSlots = await findAvailableSlots({
    urgency: 'high',
    maxDaysAhead: 3,
    preferredPeriod: flags._scheduling.preferredPeriod
  });

  return buildUrgentSchedulingResponse({
    slots: urgentSlots,
    period: flags._scheduling.preferredPeriod
  });
}
```

**Resposta:**
```
Entendi a urgência! 🚀 Deixa eu ver os horários **mais próximos** pra você:

**Hoje (15/02):**
❌ Sem vagas disponíveis

**Amanhã (16/02):**
✅ 09:00
✅ 14:30

**Sexta (17/02):**
✅ 08:00
✅ 10:30

Qual funciona melhor pra você? Vou já garantir!
```

#### 2.2. Detecção de Remarcação

**Cenário:**
```javascript
Lead já tem agendamento
Context: { hasScheduling: true }
Lead: "preciso remarcar"
```

**Estratégia:**
```javascript
if (flags._scheduling?.schedulingType === 'reschedule') {
  const currentSlot = lead.pendingChosenSlot || lead.bookedSlot;

  return buildRescheduleResponse({
    currentSlot,
    preferredPeriod: flags._scheduling.preferredPeriod,
    hasUrgency: flags._scheduling.hasUrgency
  });
}
```

**Resposta:**
```
Sem problema! 💚 Você está agendado para:
📅 Quinta, 16/02 às 14:00

Quer remarcar para quando? Me passa o melhor dia/horário pra você!
```

#### 2.3. Detecção de Cancelamento

**Cenário:**
```javascript
Lead: "não vou poder ir na consulta, surgiu um imprevisto"
```

**Estratégia:**
```javascript
if (flags._scheduling?.schedulingType === 'cancellation') {
  return buildCancellationResponse({
    currentSlot: lead.bookedSlot,
    tryReschedule: true // tentar reagendar em vez de apenas cancelar
  });
}
```

**Resposta:**
```
Que pena! 😔 Mas entendo que imprevistos acontecem.

Você prefere **remarcar** para outro dia ou realmente **cancelar**?

Se quiser remarcar, me passa quando fica melhor pra você e eu já te mando
as opções! 💚
```

#### 2.4. Detecção de Período Preferido

**Cenário:**
```javascript
Lead: "tem vaga de manhã?"
```

**Estratégia:**
```javascript
if (flags._scheduling?.preferredPeriod) {
  const slots = await findAvailableSlots({
    period: flags._scheduling.preferredPeriod, // 'morning', 'afternoon', 'flexible'
    therapyArea: lead.therapyArea
  });

  return buildPeriodSpecificResponse({
    period: flags._scheduling.preferredPeriod,
    slots
  });
}
```

**Resposta:**
```
Sim! Temos vagas de **manhã** 🌅

**Quarta (15/02):**
✅ 08:00
✅ 09:30
✅ 11:00

**Quinta (16/02):**
✅ 09:00
✅ 10:30

Qual você prefere?
```

---

### 3. 🎯 Estratégias Compostas

#### 3.1. Objeção de Preço + Quer Agendar

**Cenário:**
```javascript
Lead: "o preço tá caro, mas quero agendar"
flags: {
  _price: { priceType: 'objection' },
  _scheduling: { schedulingType: 'new' }
}
```

**Estratégia:**
```javascript
if (flags._price?.hasObjection && flags.wantsSchedule) {
  // Reconhece objeção MAS mantém foco no agendamento
  return buildObjectionWithSchedulingResponse({
    therapyArea: lead.therapyArea
  });
}
```

**Resposta:**
```
Entendo sua preocupação com o valor 💚 Mas vou garantir que você terá um
atendimento de excelência!

Deixa eu te passar os horários disponíveis. Você prefere **manhã** ou **tarde**?
```

#### 3.2. Urgência + Período Específico

**Cenário:**
```javascript
Lead: "preciso agendar urgente, de manhã"
flags: {
  _scheduling: {
    hasUrgency: true,
    preferredPeriod: 'morning'
  }
}
```

**Estratégia:**
```javascript
if (flags._scheduling?.hasUrgency && flags._scheduling?.preferredPeriod) {
  const urgentMorningSlots = await findAvailableSlots({
    urgency: 'high',
    period: 'morning',
    maxDaysAhead: 2
  });

  return buildCompositeResponse({ slots: urgentMorningSlots });
}
```

**Resposta:**
```
Entendi a urgência! 🚀 Horários de **manhã nos próximos dias**:

**Amanhã (16/02):**
✅ 09:00
✅ 10:30

Qual você prefere? Vou já confirmar!
```

---

## 🏗️ Estrutura de Implementação

### Arquivo: `/orchestrators/strategies/PriceStrategies.js`

```javascript
/**
 * Estratégias inteligentes para perguntas sobre preço
 * Usa flags._price para decidir resposta
 */

import pricing from '../../config/pricing.js';

export function buildPriceObjectionResponse({ therapyArea, objectionType }) {
  const area = therapyArea || 'fonoaudiologia';
  const price = pricing[area]?.avaliacao || 200;

  // Enfatiza VALOR, não apenas preço
  return `
Entendo sua preocupação! 💚 O valor da avaliação (R$ ${price}) já inclui:

✓ Avaliação completa (60-90min)
✓ Relatório detalhado por escrito
✓ Orientações personalizadas
✓ Plano terapêutico individualizado

E se precisar continuar, temos pacote mensal que sai mais em conta. Quer ver os horários disponíveis?
`.trim();
}

export function buildNegotiationResponse({ therapyArea, wantsDiscount, wantsInstallment }) {
  const area = therapyArea || 'fonoaudiologia';
  const price = pricing[area]?.avaliacao || 200;
  const packagePrice = pricing[area]?.pacote_mensal || 720;

  if (wantsInstallment) {
    return `
Para a avaliação (R$ ${price}) o pagamento é à vista, mas **se você fechar o pacote mensal** (R$ ${packagePrice}), conseguimos parcelar em até **2x sem juros** no cartão! 💳

Quer que eu já te passe os horários disponíveis?
`.trim();
  }

  if (wantsDiscount) {
    return `
O valor da avaliação é R$ ${price} (pagamento à vista). Não trabalhamos com desconto na avaliação, mas o **pacote mensal (R$ ${packagePrice})** já sai mais em conta que fazer sessões avulsas!

Posso te passar os horários para agendar?
`.trim();
  }

  return buildPriceObjectionResponse({ therapyArea, objectionType: 'negotiation' });
}

export function buildValuePitchResponse({ therapyArea, previouslyMentioned }) {
  const area = therapyArea || 'fonoaudiologia';
  const price = pricing[area]?.avaliacao || 200;

  if (previouslyMentioned) {
    return `
Como mencionei, são R$ ${price} pela avaliação completa 😊

Só pra você ter certeza: essa avaliação é super detalhada, você sai com um **relatório por escrito** + **plano personalizado** que pode inclusive levar para outros profissionais.

Quer marcar? Tenho vagas essa semana!
`.trim();
  }

  // Primeira menção
  return `
A avaliação completa é R$ ${price} 💚

Você sai com:
✓ Avaliação detalhada (60-90min)
✓ Relatório por escrito
✓ Plano terapêutico personalizado

Quer que eu já te passe os horários?
`.trim();
}

export function buildCompetitiveResponse({ therapyArea }) {
  const area = therapyArea || 'fonoaudiologia';
  const price = pricing[area]?.avaliacao || 200;

  return `
Entendo! 💚 É sempre bom comparar mesmo. Aqui na Fono Inova o diferencial é:

🎯 Equipe **multidisciplinar** (se precisar de outras áreas, já estamos integrados)
📋 **Relatório completo** por escrito
🏥 Clínica estruturada e referência em Anápolis há 10+ anos
⭐ +500 famílias atendidas com sucesso

O investimento é R$ ${price}, mas a qualidade do atendimento compensa. Quer experimentar? Posso te passar os horários!
`.trim();
}
```

### Arquivo: `/orchestrators/strategies/SchedulingStrategies.js`

```javascript
/**
 * Estratégias inteligentes para solicitações de agendamento
 * Usa flags._scheduling para priorizar e personalizar
 */

import { findAvailableSlots, formatSlot } from '../../services/amandaBookingService.js';

export async function buildUrgentSchedulingResponse({ therapyArea, preferredPeriod }) {
  const slots = await findAvailableSlots({
    urgency: 'high',
    maxDaysAhead: 3,
    period: preferredPeriod,
    therapyArea
  });

  if (!slots || slots.length === 0) {
    return `
Entendi a urgência! 🚀 Infelizmente não tenho vagas **imediatas** disponíveis.

As próximas vagas são para **daqui a 5-7 dias**. Quer que eu encaminhe seu caso para a **equipe avaliar** a possibilidade de um encaixe?

Ou prefere ver as vagas regulares?
`.trim();
  }

  const formattedSlots = slots.map(s => `✅ ${formatSlot(s)}`).join('\n');

  return `
Entendi a urgência! 🚀 Deixa eu ver os horários **mais próximos** pra você:

${formattedSlots}

Qual funciona melhor? Vou já garantir!
`.trim();
}

export function buildRescheduleResponse({ currentSlot, preferredPeriod }) {
  const formattedCurrent = currentSlot ? formatSlot(currentSlot) : 'seu horário atual';

  return `
Sem problema! 💚 Você está agendado para:
📅 ${formattedCurrent}

Quer remarcar para quando? ${preferredPeriod ? `Prefere ${preferredPeriod === 'morning' ? 'manhã' : 'tarde'}?` : 'Me passa o melhor dia/horário pra você!'}
`.trim();
}

export function buildCancellationResponse({ currentSlot, tryReschedule = true }) {
  const formattedCurrent = currentSlot ? formatSlot(currentSlot) : 'seu agendamento';

  if (tryReschedule) {
    return `
Que pena! 😔 Mas entendo que imprevistos acontecem.

Você prefere **remarcar** para outro dia ou realmente **cancelar**?

Se quiser remarcar, me passa quando fica melhor pra você e eu já te mando as opções! 💚
`.trim();
  }

  return `
Entendido! Vou cancelar ${formattedCurrent}.

Se precisar reagendar no futuro, é só chamar! 💚
`.trim();
}

export async function buildPeriodSpecificResponse({ period, therapyArea }) {
  const periodName = period === 'morning' ? 'manhã' : period === 'afternoon' ? 'tarde' : '';
  const periodEmoji = period === 'morning' ? '🌅' : '🌆';

  const slots = await findAvailableSlots({
    period,
    therapyArea,
    maxDaysAhead: 7
  });

  if (!slots || slots.length === 0) {
    return `
No momento não tenho vagas de **${periodName}** disponíveis 😔

Mas tenho vagas em outros períodos! Quer ver?
`.trim();
  }

  const formattedSlots = slots.map(s => `✅ ${formatSlot(s)}`).join('\n');

  return `
Sim! Temos vagas de **${periodName}** ${periodEmoji}

${formattedSlots}

Qual você prefere?
`.trim();
}
```

---

## 📝 Modificações no AmandaOrchestrator.js

### Localização: linha ~615 (após detecção)

```javascript
// ANTES (FASE 1 + 2):
const flags = detectWithContextualDetectors(text, lead, enrichedContext);
console.log("🚩 FLAGS DETECTADAS:", flags);

if (flags._confirmation) {
  console.log("✅ [CONFIRMATION]", { ... });
}
if (flags._insurance) {
  console.log("🏥 [INSURANCE]", { ... });
}

// 🆕 DEPOIS (FASE 3):
import {
  buildPriceObjectionResponse,
  buildNegotiationResponse,
  buildValuePitchResponse,
  buildCompetitiveResponse
} from './strategies/PriceStrategies.js';

import {
  buildUrgentSchedulingResponse,
  buildRescheduleResponse,
  buildCancellationResponse,
  buildPeriodSpecificResponse
} from './strategies/SchedulingStrategies.js';

const flags = detectWithContextualDetectors(text, lead, enrichedContext);

// ============================================================
// 💰 FASE 3: PRICE INTELLIGENCE
// ============================================================

// 1. Objeção de preço (prioridade ALTA)
if (flags._price?.priceType === 'objection' || flags._price?.priceType === 'comparison') {
  console.log("💰 [PRICE-STRATEGY] Objeção detectada, usando estratégia anti-objeção");

  if (flags._price.priceType === 'comparison') {
    return buildCompetitiveResponse({
      therapyArea: lead.therapyArea
    });
  }

  return buildPriceObjectionResponse({
    therapyArea: lead.therapyArea,
    objectionType: flags._price.priceType
  });
}

// 2. Negociação (desconto/parcelamento)
if (flags._price?.priceType === 'negotiation') {
  console.log("💰 [PRICE-STRATEGY] Negociação detectada");

  return buildNegotiationResponse({
    therapyArea: lead.therapyArea,
    wantsDiscount: /desconto/i.test(text),
    wantsInstallment: /parcelar|parcela/i.test(text)
  });
}

// 3. Insistência (lead perguntou de novo)
if (flags._price?.isInsistent && flags._price?.alreadyMentioned) {
  console.log("💰 [PRICE-STRATEGY] Insistência detectada, reforçando valor");

  return buildValuePitchResponse({
    therapyArea: lead.therapyArea,
    previouslyMentioned: true
  });
}

// ============================================================
// 📅 FASE 3: SCHEDULING INTELLIGENCE
// ============================================================

// 1. Urgência (prioridade ALTA)
if (flags._scheduling?.hasUrgency && flags.wantsSchedule) {
  console.log("📅 [SCHEDULING-STRATEGY] Urgência detectada");

  const response = await buildUrgentSchedulingResponse({
    therapyArea: lead.therapyArea,
    preferredPeriod: flags._scheduling.preferredPeriod
  });

  return response;
}

// 2. Remarcação
if (flags._scheduling?.schedulingType === 'reschedule') {
  console.log("📅 [SCHEDULING-STRATEGY] Remarcação detectada");

  return buildRescheduleResponse({
    currentSlot: lead.pendingChosenSlot || lead.bookedSlot,
    preferredPeriod: flags._scheduling.preferredPeriod
  });
}

// 3. Cancelamento (tentar reagendar)
if (flags._scheduling?.schedulingType === 'cancellation') {
  console.log("📅 [SCHEDULING-STRATEGY] Cancelamento detectado, tentando reagendar");

  return buildCancellationResponse({
    currentSlot: lead.pendingChosenSlot || lead.bookedSlot,
    tryReschedule: true
  });
}

// 4. Período específico
if (flags._scheduling?.preferredPeriod && flags._scheduling.preferredPeriod !== 'flexible' && flags.wantsSchedule) {
  console.log(`📅 [SCHEDULING-STRATEGY] Período preferido: ${flags._scheduling.preferredPeriod}`);

  const response = await buildPeriodSpecificResponse({
    period: flags._scheduling.preferredPeriod,
    therapyArea: lead.therapyArea
  });

  return response;
}

// ... resto do código continua normalmente
```

---

## ✅ Checklist de Implementação

### Fase 3.1: Price Strategies
- [ ] Criar `/orchestrators/strategies/PriceStrategies.js`
- [ ] Implementar `buildPriceObjectionResponse`
- [ ] Implementar `buildNegotiationResponse`
- [ ] Implementar `buildValuePitchResponse`
- [ ] Implementar `buildCompetitiveResponse`
- [ ] Testes unitários para cada estratégia

### Fase 3.2: Scheduling Strategies
- [ ] Criar `/orchestrators/strategies/SchedulingStrategies.js`
- [ ] Implementar `buildUrgentSchedulingResponse`
- [ ] Implementar `buildRescheduleResponse`
- [ ] Implementar `buildCancellationResponse`
- [ ] Implementar `buildPeriodSpecificResponse`
- [ ] Testes unitários para cada estratégia

### Fase 3.3: Orchestrator Integration
- [ ] Modificar `AmandaOrchestrator.js` (linha ~615)
- [ ] Adicionar imports das estratégias
- [ ] Implementar lógica de decisão baseada em `flags._price`
- [ ] Implementar lógica de decisão baseada em `flags._scheduling`
- [ ] Adicionar logs detalhados
- [ ] Testes de integração

### Fase 3.4: Validation & Testing
- [ ] Testes end-to-end com cenários reais
- [ ] Validar que backward compatibility é mantida
- [ ] Testar cenários compostos (objeção + agendamento)
- [ ] Validar com dados do WhatsApp export

---

## 📊 Impacto Esperado

### Métricas de Sucesso

| Métrica | Antes | Meta FASE 3 | Melhoria |
|---------|-------|-------------|----------|
| **Objeção de preço convertida** | 20% | 50% | +150% |
| **Agendamentos urgentes** | 10% | 30% | +200% |
| **Taxa de remarcação** | 60% | 80% | +33% |
| **Satisfação NPS** | 7.5 | 9.0 | +20% |

---

## 🎯 Próximos Passos

1. ✅ Aprovar plano FASE 3
2. ⏳ Implementar PriceStrategies.js
3. ⏳ Implementar SchedulingStrategies.js
4. ⏳ Integrar no AmandaOrchestrator
5. ⏳ Testes e validação
6. ⏳ Documentar FASE 3 completa

---

**Status:** 📋 PLANEJAMENTO
**Próxima ação:** Aguardando aprovação para iniciar implementação
