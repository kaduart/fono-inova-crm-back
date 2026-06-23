# DOMAIN INVARIANTS — CRM Clínica v8
## Leia este arquivo ANTES de qualquer alteração de código.

> **Regra zero:** toda IA e todo desenvolvedor que tocar neste sistema deve responder às perguntas desta página antes de propor código. Se não souber responder, leia `ARCHITECTURE_FLOW.md` e `REGRAS_NEGOCIO_CONSOLIDADO.md` primeiro.

---

## Checklist obrigatório antes de qualquer implementação

```
1. Qual entidade canônica é afetada? (ver seção PROPRIEDADE CANÔNICA)
2. Quais outras entidades são impactadas? (ver seção MAPAS DE IMPACTO)
3. Quais invariantes podem quebrar? (ver seção INVARIANTES POR DOMÍNIO)
4. Precisa de migração de dados ou script de correção?
5. Impacto no frontend (KPIs, filtros, estados visuais)?
6. É compatível com dados pré-existentes?
Só depois disso: proponha código.
```

---

## PROPRIEDADE CANÔNICA DAS ENTIDADES

| Entidade | É canônica de | NÃO é canônica de |
|----------|--------------|-------------------|
| `Appointment` | Estado da agenda, slot, ciclo de vida clínico | Financeiro (usa Payment) |
| `Payment` | Estado financeiro, caixa, DRE, A Receber | Agenda (usa Appointment) |
| `Session` | Unidade de execução clínica | Financeiro ou agenda (derivada) |
| `Package` | Contexto do pacote (tipo, sessões totais) | Financeiro (Package.financialStatus é derivado) |
| `LiminarContract` | Créditos judiciais | — |
| `Patient` | Dados do paciente | appointments array (é shadow de Appointment.patient) |
| `Doctor` | Dados do profissional | comissão (calculada por commissionRule.service.js) |

---

## MAPAS DE IMPACTO — alterei X, o que mais pode quebrar?

### Appointment
Se alterar Appointment, verificar:
- `Session` — estado deve refletir (session.status espelha appointment.status no complete/cancel)
- `Payment` — provisioning/settlement vinculados a appointment
- `Patient.appointments` — array shadow; mudança de paciente exige pull antigo + push novo
- `Availability / Conflict Detection` — slot deve ser liberado/ocupado
- `Package.sessionsUsed` — se houver packageId, consumo só no complete
- `Socket events` — frontend reage ao evento de mudança de status
- Filtros de agenda — SEMPRE incluir `pre_agendado` além de `scheduled/confirmed`

### Payment
Se alterar Payment, verificar:
- `unifiedFinancialService.v2.js` — recalcula Produção/Caixa/A Receber
- `commissionRule.service.js` → `commissionService.js` — cadeia de comissão
- `ProfessionalFinancialService` — resultado do profissional
- `ReconciliationService` — auditoria e divergências
- `Package.financialStatus` — pre-save recalcula automaticamente se payment de pacote
- Nunca alterar `Payment.status` diretamente — sempre via `transitionPaymentStatus()`

### Session
Se alterar Session, verificar:
- `Appointment` — Session só vai a completed quando Appointment vai a completed
- `Package.sessionsUsed` — $inc só no complete, nunca no agendamento
- `Payment` — settlement disparado pela conclusão da sessão
- `resolveSessionFinancialValue()` — hierarquia de valuation da sessão

### Package
Se alterar Package, verificar:
- `Package.financialStatus` — calculado automaticamente no pre-save; nunca salvar manualmente
- `Session` — consumo só no complete; nunca adiantar no agendamento
- `Payment` — `isFromPackage=true` → NUNCA entra em caixa
- `remainingSessions` — campo virtual; nunca usar `$inc`; alterar `sessionsDone`

### Patient
Se alterar Patient, verificar:
- `Patient.appointments` — deve refletir `Appointment.patient`; mudança exige: pull antigo + add novo
- Consistência com Sessions e Payments vinculados

---

## INVARIANTES POR DOMÍNIO

### Appointment (Agenda)
1. Todo Appointment nasce com status `pre_agendado` (desde 2026-05-07)
2. Ciclo de vida: `pre_agendado → scheduled → confirmed → completed | cancelled | force_cancelled`
3. `completed` dispara: Session.completed + Payment settlement + comissão
4. `cancelled` libera slot automaticamente — nunca precisa fazer isso manualmente
5. `nextAppointment` é virtual — NUNCA salvar no banco
6. Trinca obrigatória: Appointment + Session + Payment criados JUNTOS no mesmo handler
7. `force_cancelled` exige audit log obrigatório

### Payment (Financeiro)
8. `Payment` é a fonte da verdade financeira — Package não é
9. Nunca alterar `Payment.status` diretamente no Mongo — sempre via `paymentStatusService.transitionPaymentStatus()`
10. `payment.isFromPackage = true` → NUNCA entra em caixa (filtrar com `{ isFromPackage: { $ne: true }, kind: { $ne: 'package_consumed' } }`)
11. Idempotência obrigatória: verificar existência antes de criar Payment (`findOne({ appointmentId, kind })`)
12. Não usar entidades DEPRECATED: `FinancialProjection`, `TotalsSnapshot`, `FinancialDailySnapshot`
13. KPIs financeiros computados APENAS no backend — nunca recomputar no frontend

### Package (Pacote)
14. `remainingSessions` é virtual — nunca usar `$inc`; alterar `sessionsDone`
15. `Package.financialStatus` calculado no pre-save — nunca salvar manualmente (`unpaid | partially_paid | paid`)
16. `packageId` é imutável após criação
17. Sessão de pacote só é consumida no `completed`, nunca no agendamento

### Session (Sessão)
18. Session só vai a `completed` quando o Appointment vai a `completed`
19. Session não é a entidade financeira — Payment é
20. Não usar `Session.commissionValue` — comissão vem de `commissionRule.service.js`

### Amanda (WhatsApp)
21. Nunca disparar mensagem sem `detectAllFlags()` primeiro
22. Pipeline: `detectAllFlags → BusinessRulesAdapter → DecisionResolver → ResponseBuilder`
23. GMB images: usar apenas `sanitizePermanentMedia` — sem fallbacks Unsplash/Pollinations

---

## ARCHITECTURE DECISION RECORDS (ADR)

### ADR-001: Payment é a fonte da verdade financeira
**Decisão:** `Payment` é o único registro financeiro oficial. `Package.financialStatus` é derivado. `Appointment.paymentStatus` é shadow state a ser eliminado.
**Motivo:** Histórico de bugs por dupla contagem quando Package ou Appointment eram consultados diretamente para relatórios.
**Consequência:** Todo relatório/DRE/caixa lê de `Payment`, nunca de `Appointment` ou `Package`.

### ADR-002: Appointment é a fonte da verdade da agenda
**Decisão:** `Appointment` é o registro canônico do slot/agendamento. Session e Payment são derivados do Appointment.
**Motivo:** Session criada junto não significa que Session pode mudar de estado independentemente.
**Consequência:** Qualquer mudança de estado clínico começa no Appointment; Session e Payment seguem.

### ADR-003: remainingSessions é virtual
**Decisão:** `Package.remainingSessions` nunca é persistido; é calculado em runtime como `totalSessions - sessionsUsed`.
**Motivo:** Bug histórico de divergência quando `$inc` era usado diretamente.
**Consequência:** Sempre alterar `sessionsDone` ou `sessionsUsed`; nunca `$inc remainingSessions`.

### ADR-004: packageId é imutável
**Decisão:** Após a criação de um Appointment com `packageId`, o vínculo não pode ser trocado.
**Motivo:** Troca retroativa corrompe contagem de sessões e histórico financeiro do pacote.
**Consequência:** Para corrigir vínculo errado, cancelar e recriar.

### ADR-005: Trinca Appointment+Session+Payment
**Decisão:** Os três são criados no mesmo handler, no mesmo request. Não existe Appointment sem Session nem sem Payment.
**Motivo:** Consistência transacional — qualquer rollback deve desfazer os três.
**Consequência:** Handlers de criação de agendamento NUNCA criam apenas Appointment.

### ADR-006: Status inicial = pre_agendado
**Decisão:** Todo Appointment nasce como `pre_agendado` (desde 2026-05-07). Status anterior `pending` foi migrado.
**Motivo:** Distinguir agendamentos que ainda não foram confirmados pela secretária.
**Consequência:** TODOS os filtros de "agendamentos ativos" devem incluir `pre_agendado` além de `scheduled` e `confirmed`.

### ADR-007: KPIs computados apenas no backend
**Decisão:** Nenhum cálculo financeiro (totais, médias, projeções) é feito no frontend.
**Motivo:** Shadow variable local no frontend pode mascarar o valor correto vindo do backend. Bug histórico: `particularPendente` mostrava R$5.920 no frontend mas R$5.230 era o correto.
**Consequência:** Frontend exibe apenas o que recebe da API; nunca reduz, soma ou transforma valores financeiros localmente.

### ADR-008: Regime de competência (desde 2026-05-26)
**Decisão:** Dois regimes coexistem: Produção = Recebimento + A Receber; Caixa = Recebimento + Retroativos.
**Motivo:** Gestão clínica precisa de visão de produção independente de quando o dinheiro entrou.
**Consequência:** `serviceDate` é o campo correto para competência clínica; `financialDate` para caixa.

---

## CAMPOS DE DATA — QUAL USAR

| Propósito | Campo oficial | Fallback |
|-----------|--------------|---------|
| Caixa / DRE | `payment.financialDate` | `payment.paymentDate` |
| Competência clínica | `appointment.date` | `session.date` |
| Auditoria operacional | `payment.paidAt` | — |
| Liminar — data financeira | `receipt.paymentDate` → `receivedAt` → `creditHistory.initial` → `createdAt` | Nessa ordem |

---

## ANTI-PATTERNS — código que quebra o sistema

```js
// ❌ NUNCA — atualização direta de Payment.status
await Payment.findByIdAndUpdate(id, { status: 'paid' });
// ✅ SEMPRE
await transitionPaymentStatus(id, 'paid', { reason, userId });

// ❌ NUNCA — package_consumed entra em caixa
payments.filter(p => p.status === 'paid')  // inclui package_consumed por engano
// ✅ SEMPRE
payments.filter(p => p.status === 'paid' && !p.isFromPackage && p.kind !== 'package_consumed')

// ❌ NUNCA — calcular KPI no frontend
const total = appointments.reduce((sum, a) => sum + a.amount, 0);
// ✅ SEMPRE — consumir do backend
const { caixa } = await fetch('/api/v2/financial/dashboard');

// ❌ NUNCA — criar Payment sem verificar duplicata
await new Payment({ appointmentId, kind }).save();
// ✅ SEMPRE — idempotência
const existing = await Payment.findOne({ appointmentId, kind });
if (!existing) await new Payment({ appointmentId, kind, ... }).save();

// ❌ NUNCA — $inc em remainingSessions
await Package.findByIdAndUpdate(id, { $inc: { remainingSessions: -1 } });
// ✅ SEMPRE — alterar sessionsUsed/sessionsDone; remainingSessions é virtual

// ❌ NUNCA — Session muda para completed sem Appointment
await Session.findByIdAndUpdate(id, { status: 'completed' });
// ✅ SEMPRE — completar via endpoint do Appointment: POST /api/appointments/:id/complete

// ❌ NUNCA — Amanda dispara sem detectAllFlags
await ResponseBuilder.send(message);
// ✅ SEMPRE — pipeline completo: detectAllFlags → BusinessRulesAdapter → DecisionResolver → ResponseBuilder

// ❌ NUNCA — usar entidades deprecated
FinancialProjection / TotalsSnapshot / FinancialDailySnapshot / financialMetrics.service.js
// ✅ SEMPRE — unifiedFinancialService.v2.js
```

---

## SERVIÇOS OFICIAIS — referência rápida

| O que fazer | Serviço oficial | Nunca usar |
|-------------|----------------|-----------|
| Mudar Payment.status | `paymentStatusService.transitionPaymentStatus()` | `Payment.findByIdAndUpdate({ status })` |
| Calcular produção/caixa | `unifiedFinancialService.v2.js` | `financialMetrics.service.js` (deprecated) |
| Valor da sessão | `resolveSessionFinancialValue.js` | `session.sessionValue` direto |
| Comissão por sessão | `commissionRule.service.js` | `Session.commissionValue` |
| A Receber / auditoria | `ReconciliationService` | cálculo manual no frontend |
| Settlement convênio avulso | `autoInsuranceSettlementService.js` | update direto em Payment |
| Lote convênio | `insuranceBatchService.js` | settlement avulso em loop |
| Sincronizar views após mutation | `syncAffectedViews()` | invalidação manual por view |

---

## REFERÊNCIAS

- Fluxos completos: `back/docs/ARCHITECTURE_FLOW.md`
- Regras de negócio: `back/REGRAS_NEGOCIO_CONSOLIDADO.md`
- Event-driven: `back/docs/ARQUITETURA_EVENT_DRIVEN.md`
- Arquitetura geral: `back/ARQUITETURA_4.0_COMPLETA.md`
- Fonte única financeira: `back/docs/FINANCIAL_SOURCE_OF_TRUTH.md`
- Contrato de API: `back/docs/API_CONTRACT_V2.md`
- Segurança e rotas: `back/SEGURANCA_ROTAS.md`

---

## Changelog

| Data | Mudança |
|------|---------|
| 2026-06-23 | Criação — consolidação de invariantes, ADRs e mapas de impacto para entrada de qualquer IA |
