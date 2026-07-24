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

### Convênio (InsuranceGuide / InsuranceBatch)
21. `InsuranceGuide.sessionValue` é a fonte oficial do valor contratado da sessão de convênio
22. `Session.sessionValue` deve espelhar `InsuranceGuide.sessionValue` para fins de produção clínica
23. `Payment.amount` representa o valor efetivamente faturado/recebido e pode divergir da guia por glosa, pagamento parcial ou ajuste financeiro
24. Todo endpoint que agrupa/consulta convênio deve usar `InsuranceResolverService` para resolver `provider` e `patient` com a mesma hierarquia
25. `Payment.status = 'paid'` **NÃO implica** `Appointment.operationalStatus = 'completed'`. Os dois são máquinas de estado independentes — um pagamento pode existir antes, durante ou completamente desacoplado da realização do atendimento (pagamento antecipado, paciente que paga e falta). Somente `completeSessionService.v2` pode transicionar um Appointment/Session para `completed`. Confirmar presença (`confirmed`) nunca conclui atendimento (Investigação 2026-07-09, caso Benjamin/Ercy — ver `back/docs/2026-07-09-appointment-confirmed-socket-and-package-updated-audit.md`)

### Amanda (WhatsApp)
21. Nunca disparar mensagem sem `detectAllFlags()` primeiro
22. Pipeline: `detectAllFlags → BusinessRulesAdapter → DecisionResolver → ResponseBuilder`
23. GMB images: usar apenas `sanitizePermanentMedia` — sem fallbacks Unsplash/Pollinations
24. Toda fila BullMQ de WhatsApp precisa ter exatamente um Worker registrado no grupo `whatsapp` de `back/workers/registry.js` — o grupo que de fato roda em produção (`crm-worker` → `workers/startWorkers.js`). Nunca registrar um consumidor só em `workers/entrypoints/whatsapp-child.js` (modo emergência, não roda em produção) achando que isso basta. Antes de renomear/remover uma fila, checar todos os `.add()` para ela (rotas, outros services, apps externos como `agenda`)
25. `whatsappPipelineGuard.js` (`startWhatsAppPipelineGuard()`) deve permanecer chamado no boot de `workers/startWorkers.js` — é o único alerta automático que detecta fila de WhatsApp pausada ou sem consumidor. Ficou implementado e sem uso por meses (incidente 2026-07-24) até ser religado

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

### ADR-009: InsuranceResolverService é a única fonte de resolução de convênio e paciente
**Decisão:** Toda consulta/agrupamento por convênio (`provider`) e por paciente em contexto de convênio passa por `InsuranceResolverService`.
**Motivo:** Resolver provider/payment em múltiplos pontos do código gerou relatórios contraditórios (ex: mesmo payment aparecia como `unimed-anapolis`, `Convenio` e `Outros` em telas diferentes).
**Consequência:**
- Hierarquia de provider: `Payment.insurance.provider → Session.insuranceProvider → Session.insuranceGuide.insurance → Appointment.insuranceProvider → InsuranceBatch.insuranceProvider → Package.insuranceProvider → "Outros"`.
- Hierarquia de patient: `Session.patient → Appointment.patient → Payment.patient`.
- Nenhum endpoint novo deve reimplementar essa lógica; sempre importar `InsuranceResolverService`.

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

// ❌ NUNCA — criar/migrar fila BullMQ sem confirmar quem consome
export const minhaQueue = new Queue("minha-fila", { connection: bullMqConnection });
// nenhum `new Worker("minha-fila", ...)` no grupo `whatsapp` de registry.js
// → jobs ficam em `waiting` para sempre, ZERO log (foi o caso de `whatsapp-send`, 2026-07-24)
// ✅ SEMPRE — registrar o Worker em registry.js (grupo que roda em produção)
// e validar com getQueue(nome).getWaitingCount() antes de considerar pronto
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

- Ciclo de vida cancel ⇄ restore de Appointment: `back/docs/architecture/APPOINTMENT_LIFECYCLE.md`
- Fluxos completos: `back/docs/ARCHITECTURE_FLOW.md`
- Regras de negócio: `back/REGRAS_NEGOCIO_CONSOLIDADO.md`
- Event-driven: `back/docs/ARQUITETURA_EVENT_DRIVEN.md`
- Arquitetura geral: `back/ARQUITETURA_4.0_COMPLETA.md`
- Fonte única financeira: `back/docs/FINANCIAL_SOURCE_OF_TRUTH.md`
- Contrato de API (geral): `back/API_CONTRACT_V2.md`
- Contrato de API (complete session): `back/docs/API_CONTRACT_COMPLETE_SESSION.md`
- Segurança e rotas: `back/SEGURANCA_ROTAS.md`

---

---

## ADR-010: novaReceitaMes é um KPI híbrido intencional

**Data:** 2026-06-25  
**Contexto:** Investigação de possível duplicidade ao marcar convênio como recebido (`paidAt`).

**Decisão:** `novaReceitaMes` mistura dois regimes contábeis:

| Fonte | Regime | Campo de data |
|-------|--------|---------------|
| Convênio | Competência (produção) | `session.date` |
| Particular | Caixa (pagamento real) | `paymentDate / financialDate` |
| Pacote | Caixa (venda do pacote) | `paymentDate / financialDate` |

**Por que é intencional:** convênio nunca gera caixa imediato — o dinheiro entra semanas/meses depois. Forçar caixa quebraria a previsibilidade de produção clínica.

**Consequências:**
- `novaReceitaMes` NÃO é "dinheiro recebido" — é "valor gerado no período"
- `novaReceitaMes` vs `caixa.total` SEMPRE vai ter diferença para convênio — isso é normal
- Marcar convênio como `received` (paidAt) **NÃO inflaciona `novaReceitaMes`** do mês do recebimento
- A diferença entre `producaoDetalhe.convenio` e `caixaDetalhe.convenio` = `convenioAReceber` (correto)

**Anti-pattern crítico — NUNCA fazer:**
```js
// ❌ NUNCA — mover convênio para paidAt em novaReceitaMes
Session.aggregate([{ $match: { paidAt: { $gte: start } } }])

// ❌ NUNCA — mover particular/pacote para session.date em novaReceitaMes
Payment.aggregate([{ $match: { 'session.date': { $gte: start } } }])

// ❌ NUNCA — comparar novaReceitaMes com caixa.total esperando igualdade
assert(novaReceitaMes.total === caixa.total) // sempre diferente quando há convênio
```

**Padrão correto:**
```js
// ✅ SEMPRE — convênio em novaReceitaMes usa session.date (competência)
Session.aggregate([{ $match: { date: { $gte: start }, paymentMethod: 'convenio' } }])

// ✅ SEMPRE — convênio no caixa usa receivedAt (paidAt)
Payment.find({ 'insurance.receivedAt': { $gte: start } })

// ✅ SEMPRE — separar os três KPIs no dashboard
novaReceitaMes  = produção do período (híbrido competência/caixa)
caixa.total     = dinheiro real recebido
convenioAReceber = produção.convenio - caixa.convenio
```

---

## ADR-011: Projeção financeira de caixa baseada em heurística de lote retroativo (transição)

**Status:** Accepted (Temporary) — deve ser substituída quando existir classificação explícita de natureza do recebimento.

**Data:** 2026-07-10  
**Contexto:** A projeção de fechamento do mês (`cashflow.v2.js`, `comparativos.projecaoMes`) usava `média diária × dias do mês`, sensível a outliers — um recebimento retroativo de uma paciente quitando 13 sessões antigas de uma vez (R$1.990) inflou a projeção de um dia de R$27 mil de ritmo real para R$48.650 projetados. Discussão levou a duas iterações rejeitadas antes de fechar nesta:

1. **v1** (excluir qualquer atraso >3 dias + venda de pacote): dados reais mostraram que `package_receipt` é 20-29 vendas/mês nesta clínica — receita recorrente, não extraordinária. Excluí-la era um falso positivo baseado em suposição, não em evidência.
2. **v2** (final): só remove da base da projeção pagamentos que formam **lote retroativo real** — 2+ sessões distintas do mesmo paciente liquidadas no mesmo dia, com defasagem >7 dias em ao menos uma. Um atraso isolado (boleto D+10, PIX alguns dias depois) não é mais tratado como extraordinário.

**Decisão:** Enquanto `Payment` não tiver um campo explícito de natureza econômica do recebimento, a projeção usa a heurística de lote acima (parâmetros em `PROJECTION_RULES` — `retroactiveGapDays`, `minimumBatchSessions` — em `cashflow.v2.js`). `liminar_contract_receipt` continua sempre excluído da base de projeção (crédito judicial, cadência imprevisível por natureza — sem venda regular para contradizer, 0 registros legítimos nos últimos 6 meses). O **Caixa realizado nunca exclui nada** — a heurística só afeta a base da extrapolação, não o total mostrado.

**Por que é heurística, não regra contábil:** o sistema infere intenção financeira por data e repetição, não pela razão real do pagamento. Casos legítimos e recorrentes podem passar o mesmo padrão de "lote" (ex: paciente que sempre paga várias sessões do mês de uma vez; empresa que paga funcionários todo dia 30) e seriam falsos positivos.

**Consequências:**
- Pode haver falso positivo em padrões de pagamento em lote que são, na prática, recorrentes.
- Thresholds são configuráveis (`PROJECTION_RULES`), não regra de negócio fixa — ajustar sem tocar na lógica.
- **Esta ADR deve ser revisitada/removida** quando `Payment` ganhar uma classificação explícita de natureza (ex.: `nature: RECURRING_OPERATION | RECOVERY | JUDICIAL | ADVANCE | ADJUSTMENT`, ou `projectionBehavior: include | exclude`) preenchida no momento da criação do pagamento — nesse cenário a projeção deixa de inferir por data/quantidade e passa a refletir uma decisão de domínio.

**Evolução alvo:**
```
Hoje:      Payment → heurística (data + repetição) → projeção
Evolução:  Payment.nature / Payment.projectionBehavior → projeção  (sem inferência)
```

**Roadmap de aposentadoria** (critério explícito para esta ADR não virar permanente por inércia):
- **Curto prazo (atual, 2026-07-10):** heurística operacional de lote retroativo (esta ADR). `PROJECTION_RULES` configurável, sem alterar lógica.
- **Médio prazo:** adicionar `Payment.nature` (`RECURRING_OPERATION | RECOVERY | JUDICIAL | ADVANCE | ADJUSTMENT`) ou `Payment.projectionBehavior` (`include | exclude`) ao modelo de domínio, preenchido no momento da criação do pagamento pelos handlers/services que já sabem a origem (ex.: `liminarContractController.js` sempre grava `JUDICIAL`/`exclude`; quitação em lote registrada manualmente grava `RECOVERY`/`exclude`; sessão/pacote normal grava `RECURRING_OPERATION`/`include`).
- **Longo prazo:** `cashflow.v2.js` para de inferir por data/quantidade de sessões — a projeção passa a somar só por `projectionBehavior === 'include'`, e esta ADR-011 é encerrada (marcar `Status: Superseded by ADR-0XX`), removendo a heurística de lote do código.

---

## Changelog

| Data | Mudança |
|------|---------|
| 2026-07-24 | Invariantes #24-25 (Amanda): fila whatsapp-send sem Worker em produção (jobs presos sem log) + whatsappPipelineGuard nunca ligado. Fix: whatsappWebSendWorker.js criado, registry.js e startWorkers.js atualizados |
| 2026-07-10 | ADR-011: projeção de caixa por lote retroativo (heurística de transição, thresholds configuráveis) |
| 2026-06-25 | ADR-010: KPI híbrido novaReceitaMes — regime de competência para convênio, caixa para particular/pacote |
| 2026-06-25 | billingMode per_month/per_guide: paidAt projetado em getInsuranceReceivables |
| 2026-06-23 | Criação — consolidação de invariantes, ADRs e mapas de impacto para entrada de qualquer IA |
