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

**Se a mudança envolve fila BullMQ ou worker**, checklist adicional (ver ADR-012):
```
7. A fila tem um Worker consumidor registrado e confirmado?
8. O entrypoint validado é o que REALMENTE roda em produção? (checar Start
   Command no dashboard do Render — não confiar em render.yaml/nome de arquivo)
9. Existe health check ou watchdog cobrindo essa fila?
10. Testou publicando um job de verdade e confirmando consumo (log de
    início + conclusão), não só leitura de código?
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
- `paymentRole` (`standard`/`deposit`/`balance`) — todo código que busca "o Payment do appointment" pra liquidar/editar/cancelar precisa saber que pode existir um sinal (`deposit`) além do saldo; `Appointment.payment` nunca aponta pro sinal, mas lookups heurísticos por `appointment`/`session` sem filtrar `paymentRole` podem encontrá-lo por engano — ver `domain/payment/depositBalance.js`

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
- `PackagesView` — QUALQUER campo novo de configuração/agendamento adicionado ao `Package` precisa ser replicado manualmente no schema da view **e** em `buildPackageView()`; a projeção CQRS não herda campos novos automaticamente (ver ADR-014)
- `packageService.ts` (frontend) e `createPackageData()` (backend) — ambos têm whitelist própria (`sanitizeV2Payload` / destructuring explícito); campo novo enviado na criação precisa ser adicionado nos dois, senão é descartado silenciosamente antes de chegar no banco

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
13a. Consulta particular com sinal+saldo (2026-09-04) usa 2 Payments distintos
    (`paymentRole`: `deposit` + `balance`), nunca 1 Payment com `paidAmount`/
    `remainingAmount` — Caixa Real soma `Payment.amount` direto, um único
    Payment com valor parcial ficaria invisível até quitar 100%. `kind`
    permanece `'session_payment'` nos dois — `paymentRole` é eixo ortogonal.
    `Appointment.payment` sempre aponta pro saldo (`balance`/`standard`),
    nunca pro sinal (`deposit`). Ver
    `back/docs/FINANCIAL_SOURCE_OF_TRUTH.md#sinal--saldo-paymentpaymentrole--decisão-de-negócio-2026-09-04`
    e `back/domain/payment/depositBalance.js`.

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
24. **O Start Command real do `crm-worker` no Render é `node workers/entrypoints/whatsapp-only.js`, NÃO `workers/startWorkers.js`** — apesar do `render.yaml` (que já se declara não-autoritativo) sugerir o segundo. Confirmar sempre no dashboard (Settings → Start Command) antes de assumir qual arquivo está rodando; `workers/startWorkers.js`/`workers/registry.js` (grupo `whatsapp`) hoje só rodam em modos `dev:worker*`/`dev:isolated*`, não em produção
25. A fila `whatsapp-send` (consumida por `POST /api/whatsapp-web/send`, usada pelo app `agenda`) já tem consumidor **dentro de** `workers/entrypoints/whatsapp-child.js` (forkado por `whatsapp-only.js`) — não registrar um segundo consumidor em `registry.js`/`workers/startWorkers.js` para essa fila; isso cria risco real de dois Workers concorrentes se algum dia os entrypoints forem unificados ou alguém rodar `dev:worker:whatsapp` local pensando que reflete produção
26. Antes de diagnosticar "fila sem consumidor" num incidente de WhatsApp, checar primeiro `GET /api/admin/whatsapp-queue/status` (ou painel `/admin?tab=WhatsApp`) — se `completed > 0` no histórico, o consumidor existe e sempre existiu; o problema mais provável é a sessão do WhatsApp Web (Puppeteer) desconectada, não a fila
27. **Nunca rodar um segundo processo `whatsapp-only.js`/`whatsapp-child.js` (local ou em outro serviço) enquanto o de produção está ativo** — como local e produção compartilham o mesmo MongoDB (sinalização de reconexão via `WhatsAppWebState`) e potencialmente a mesma sessão WhatsApp, dois clientes Puppeteer simultâneos derrubam a sessão real (incidente 2026-07-24, causado exatamente assim)
28. `whatsappPipelineGuard.js` (`startWhatsAppPipelineGuard()`) deve permanecer chamado no boot de `back/server.js` (processo real do `crm-backend`) — é o único alerta automático que detecta fila de WhatsApp pausada ou job parado sem consumidor. Ficou implementado e sem uso por meses (achado durante o incidente de 2026-07-24) até ser religado; tomar cuidado para não religar só em `workers/startWorkers.js` (não roda em produção — mesmo erro do item #24)

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

// ❌ NUNCA — patientBalance.transactions.push(x); await patientBalance.save()
// Mongoose revalida o array `transactions` INTEIRO no .save(), não só o item
// novo — um lançamento legado quebrado (sem description) trava QUALQUER
// escrita nova nesse documento, mesmo sem relação com ela (incidente real
// 2026-09-15, ver ADR-019). validateModifiedOnly:true NÃO resolve isso.
// ✅ SEMPRE — PatientBalance.updateOne({...}, {$push:{transactions:x}, $inc:{...}},
//            { runValidators: true, context: 'query' })

// ❌ NUNCA — filtrar campos de um subdocumento de array como campos soltos
await PatientBalance.updateOne(
  { 'transactions._id': debitId, 'transactions.isPaid': { $ne: true } }, ...
);
// $ne num campo multikey checa "NENHUM elemento do array tem esse valor",
// não "o elemento encontrado não tem esse valor" — com 2+ débitos no array,
// isso trava silenciosamente a quitação de qualquer um depois que outro já
// foi marcado pago (achado por teste, não por inspeção — ver ADR-019).
// ✅ SEMPRE — $elemMatch escopa as duas condições no MESMO elemento
await PatientBalance.updateOne(
  { transactions: { $elemMatch: { _id: debitId, isPaid: { $ne: true } } } }, ...
);

// ❌ NUNCA — Payment.status muda pra 'paid' sem reconciliar o débito de fiado
// PATCH /api/v2/payments/:id marcava Payment paid sem nunca tocar
// PatientBalance — débito de sessão fiada ficava aberto pra sempre mesmo com
// o dinheiro já recebido.
// ✅ SEMPRE — transitionPaymentStatus(id, 'paid', { reconcilePatientBalance: true })
//            quando a chamada está FORA de um fluxo dedicado (pacote/multi/register-debit)

// ❌ NUNCA — Session muda para completed sem Appointment
await Session.findByIdAndUpdate(id, { status: 'completed' });
// ✅ SEMPRE — completar via endpoint do Appointment: POST /api/appointments/:id/complete

// ❌ NUNCA — Amanda dispara sem detectAllFlags
await ResponseBuilder.send(message);
// ✅ SEMPRE — pipeline completo: detectAllFlags → BusinessRulesAdapter → DecisionResolver → ResponseBuilder

// ❌ NUNCA — usar entidades deprecated
FinancialProjection / TotalsSnapshot / FinancialDailySnapshot / financialMetrics.service.js
// ✅ SEMPRE — unifiedFinancialService.v2.js

// ❌ NUNCA — assumir qual arquivo roda em produção pelo render.yaml/nome do worker
// render.yaml diz "workers/startWorkers.js", mas o Start Command real (dashboard)
// pode ser outro (ex: workers/entrypoints/whatsapp-only.js) — confirmar sempre
// ✅ SEMPRE — checar Settings → Start Command no dashboard do Render antes de
// registrar/remover um consumidor de fila

// ❌ NUNCA — diagnosticar "fila sem consumidor" sem checar o histórico da fila
if (waiting > 0) throw new Error('sem consumidor'); // completed pode já provar que existe
// ✅ SEMPRE — GET /api/admin/whatsapp-queue/status: se completed > 0, o
// consumidor existe/existiu; investigar a conexão real (ex: sessão WhatsApp
// Web) antes de criar um Worker novo (incidente 2026-07-24)

// ❌ NUNCA — rodar um segundo whatsapp-only.js/whatsapp-child.js local
// enquanto produção está ativa (mesmo Mongo/sessão => derruba a sessão real)
// ✅ SEMPRE — usar sessão/número de WhatsApp de teste isolado para rodar local
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

### ADR-012: Toda fila BullMQ precisa de consumidor confirmado no entrypoint real de produção
**Decisão:** nenhuma fila é considerada "resolvida" só porque existe um `new Worker(...)` em algum arquivo do repo. O consumidor precisa estar registrado no processo que **de fato** roda em produção — confirmado pelo Start Command real (dashboard do Render, Settings), nunca assumido por `render.yaml` (não-autoritativo, ver topo do arquivo) ou pelo nome/local do arquivo.
**Motivo:** incidente 2026-07-24 (fila `whatsapp-send`) — diagnóstico inicial presumiu "sem consumidor" batendo o código com `render.yaml`, gerando um segundo Worker desnecessário. A fila sempre teve consumidor; o `render.yaml` mentia sobre qual arquivo sobe no `crm-worker`. Ver [[project_whatsapp_send_queue_no_consumer_incident]] e itens #24-28 (seção Amanda/WhatsApp) para o caso concreto.
**Consequência:** antes de declarar uma fila "sem consumidor", checar histórico real (`completed > 0` já prova que existiu consumidor) via admin/health endpoint — não só leitura de código. Ver checklist adicional (itens 7-10) no topo deste arquivo. Mapa de filas → consumidor → entrypoint documentado em `docs/ARQUITETURA_EVENT_DRIVEN.md` (seção "Filas").

### ADR-013: dependências GitHub em produção nunca apontam pra branch (`#main`) — sempre tag/release/commit SHA
**Decisão:** `package.json` fixava `whatsapp-web.js` em `github:wwebjs/whatsapp-web.js#main` — uma branch, não uma tag/commit. Sem `package-lock.json` no repo, cada `npm install` (todo deploy) podia resolver um commit diferente do `main`, sem ninguém decidir isso conscientemente.

**Causa raiz técnica identificada com alta confiança (RCA final, 2026-07-24):** uma alteração interna do WhatsApp Web em julho/2026 renomeou a propriedade `id._serialized` para `id.$1`. A versão de `whatsapp-web.js` em uso não tinha compatibilidade com essa mudança, causando falhas em todo o fluxo de `sendMessage()` — erro `r: r`, stack trace localizado em `Client.sendMessage` → Puppeteer `ExecutionContext.evaluate`. Identificado via PR upstream [wwebjs/whatsapp-web.js#201832](https://github.com/wwebjs/whatsapp-web.js/pull/201832) ("fix(client): add fallback for WhatsApp id._serialized renamed to id.$1"), 4 aprovações de revisores, adotada de forma independente por múltiplos forks (waha, Eonus21, telmedola) — corroboração forte, mas **ressalva**: a correção upstream oficial ainda está em revisão, não mesclada no `main` do repo oficial `wwebjs/whatsapp-web.js`.

**Hotfix aplicado (bridge temporário, não solução definitiva):**
```
whatsapp-web.js
origem: fork lindionez/whatsapp-web.js (não é a org oficial)
commit: f4ea1e3cf4076e44e36dfe5f81ea57048d2f7761
```
Diff conferido manualmente antes de aplicar: só adiciona fallback `_serialized || $1` em `Client.js`/`Utils.js` (Injected) + reformatação, sem dependência nova, sem chamada de rede/exec fora de escopo.

**Regra permanente (vale para qualquer dependência, não só esta):** dependências `github:owner/repo#ref` em produção são proibidas apontando para branch (`#main`, `#master` etc). Sempre usar tag, release ou commit SHA explícito. Ao fixar um SHA por causa de um incidente, documentar aqui: qual SHA, em que data, e por quê — para não virar um "commit misterioso" que ninguém entende daqui a meses.

**Tarefa de retorno (não fechar até acontecer):** quando a PR #201832 for mesclada no `main` oficial, trocar `lindionez/whatsapp-web.js#f4ea1e3...` de volta para `wwebjs/whatsapp-web.js#<novo-sha-oficial>` — o fork pessoal é ponte, não destino final. Auditoria futura que encontrar esse fork sem essa nota já sabe o motivo.

**Consequência:** `package-lock.json` ainda não existe no repo `back` — o projeto é um **monorepo com npm workspaces** (`/home/user/projetos/crm` na raiz), então `node_modules`/`package-lock.json` reais ficam fora de `back/`, numa pasta que não é repositório git. Isso não bloqueia o deploy: o Render clona só o `back` isoladamente e gera seu próprio lockfile no build a partir do `package.json` já commitado — o pin por SHA garante determinismo mesmo sem lockfile local. Gerar/commitar um `package-lock.json` dentro do repo `back` (dívida técnica geral, não urgente) fica pra outra sessão.

**Pipeline validado por rastreamento de código (não suposição):** o botão "Confirmar agendamento" do app `agenda` (`AppointmentRow.jsx` → `sendViaExtension()` → `POST /api/whatsapp-web/send`) usa exatamente este pipeline corrigido — confirmado lendo o código, não assumido.

Checklist pós-deploy: (1) conectar sessão (QR), (2) enviar mensagem pra número normal, (3) enviar pra contato com LID, (4) conferir retorno de `sendMessage()`, (5) checar logs sem `Cannot read properties of undefined`. Quando a PR mesclar oficialmente: atualizar o SHA pro oficial, testar de novo, remover a nota de "fork temporário" daqui.

### ADR-014: Campos novos no Package não aparecem automaticamente em PackagesView
**Decisão:** Todo campo de configuração adicionado ao schema do `Package` deve ser adicionado também ao schema de `PackagesView` **e** à função `buildPackageView()` (`domains/billing/services/PackageProjectionService.js`) — nenhum dos dois herda automaticamente do outro. Se o campo também precisa ser enviado pelo frontend na criação, checar ainda `sanitizeV2Payload()` (`front/src/services/packageService.ts`) e `createPackageData()` (`packageController.v2.js`) — ambos têm whitelist própria que descarta silenciosamente campos não listados.
**Motivo:** `PackagesView` é uma projeção CQRS materializada, montada manualmente a partir de um subconjunto de campos do `Package` (`fetchRawData`/`viewData` em `PackageProjectionService.js`). Ao adicionar `frequencyInterval` (feature de pacote quinzenal, 2026-08-06) apenas ao `Package`, o dado gravava certo no write model mas nunca chegava no frontend — todos os endpoints de leitura de Package (`GET /:id`, `GET /patient/:id`, listagem) leem exclusivamente de `PackagesView`, nunca do `Package` direto. Achado só depois de rastrear a cadeia completa: schema → controller → sanitize do frontend → projection builder → schema da view.
**Consequência:** checklist ao adicionar campo novo no `Package`: (1) schema `Package.js`; (2) schema `PackagesView.js`; (3) `viewData` em `buildPackageView()`; (4) `sanitizeV2Payload()` no frontend, se o campo for enviado na criação/edição; (5) `createPackageData()` no backend, mesma razão.

### ADR-015: O profissional dono de um pagamento é resolvido por `Session.doctor`, nunca por `Payment.doctor`
**Decisão:** Reconciliação, produção, comissão e fechamento mensal resolvem o profissional pelo caminho `Payment → Session → Session.doctor`. `Payment.doctor` é snapshot histórico do contexto de criação e **não pode** ser usado para filtrar pagamentos elegíveis, definir o profissional da receita, identificar sessões órfãs ou calcular produção. Detalhamento completo, evidências e casos divergentes em `FINANCIAL_DOMAIN_INVARIANTS.md` — INVARIANTE 16.

**Motivo:** `reconciliation.service.js` montava `doctorPayments` filtrando por `payment.doctor === doctorId` **antes** de resolver o vínculo canônico (`linkPaymentToSession()`, que usa `Payment.session`/`Payment.appointment`). Auditoria em produção (2026-08-07) mediu 440 Payments com `session` preenchida e `doctor` ausente — 268 já pagos, R$ 51.320,01, 15 profissionais. Consequência visível: 133 de 162 alertas de "sessão órfã" (82%) eram falso positivo, bloqueando o fechamento mensal sem pendência real. A trava de segurança da auditoria também encontrou 3 Payments com `doctor` divergente de `Session.doctor` (R$ 360): dois criados no mesmo timestamp, mesmo `doctor`, apontando para sessões de profissionais diferentes (criação em lote herdando contexto), e um resíduo legado (session cancelada sem `appointmentId`). Ou seja, o campo falha por **duas** vias independentes — ausência e atribuição incorreta na origem.

**Consequência:** (1) nenhum consumidor financeiro pode reintroduzir filtro por `Payment.doctor` como "otimização" — o campo é auxiliar, mesma classe de erro já documentada em `FINANCIAL_SOURCE_OF_TRUTH.md:65`; (2) os 3 casos divergentes **não são resolvidos** pela mudança e permanecem como pendência operacional (faturamento e comissão já processados); (3) `Payment.doctor` continua gravado e preservado, porque é o que torna essas divergências auditáveis; (4) auditoria reexecutável por `scripts/audit-reconciliation-payment-doctor-gap.js`.

### ADR-016: Script de teste, diagnóstico ou validação nunca escreve em produção
**Decisão:** Todo script ou teste que cria/altera dados deve chamar `assertNotProductionDb()` (`back/utils/assertNotProductionDb.js`) **antes** de `mongoose.connect()`. O guard aborta se detectar `NODE_ENV=production`, ambiente Render, URI apontando pro cluster/banco produtivo, ou `DB_NAME` produtivo. Fora de produção, escrita de dado de teste ainda exige liberação explícita: `ALLOW_TEST_DATA_WRITE=true`. Scripts que criam dado devem envolver a parte mutante em `try/finally` com limpeza no `finally` — cleanup só no caminho feliz deixa meia trinca no banco quando estoura no meio.

**Motivo:** em 3 dias foram removidos 42 + 35 + 11 pacientes de teste, 15 guias e 1 convênio de produção. A origem não era uma suite de CI: eram scripts de `back/scripts/` e a suite `back/tests/e2e/v2/` com a URI de produção **hardcoded**, rodando contra `fono_inova_prod`. `preparar-guia-para-teste-ui.mjs` sozinho criou 28 pacientes idênticos, cada rodada gerando Patient + Guide + 3 Appointments + Sessions + Payment. A contaminação escalou: na 1ª limpeza nenhum paciente de teste tinha dado real vinculado; na 2ª, um já tinha 4 appointments, 4 sessions, 2 payments e 2 packages entrando nos números financeiros.

**Consequência:** (1) rodar qualquer script protegido contra o `.env` de produção agora falha com mensagem explícita, não com dado criado; (2) a suite `tests/e2e/v2` exige `ALLOW_TEST_DATA_WRITE=true` mesmo local — é intencional, o custo de digitar a variável é menor que o de limpar produção; (3) marcador `_testData` no documento **não** funciona nesses schemas (modo strict descarta o campo silenciosamente) — a limpeza rastreia `_id` dos documentos criados; (4) `--keep` existe só para debug local e imprime o que ficou.

---

### ADR-017: Payments originais sao o caixa no bulk-settle

**Decisao:** `monthly_settlement` e `debt_settlement` sao recibos agregadores
auditaveis e nao contabilizaveis. A entrada canonica e composta exclusivamente
pelos Payments originais listados em `settledPaymentIds`, apos sua transicao
transacional para `paid`. A constante `CASH_NON_COUNTABLE_KINDS` rege Caixa,
Dashboard e agregacao diaria.

**Alternativa rejeitada:** contabilizar somente o recibo e tornar os originais
nao contabilizaveis. Essa alternativa esconderia a granularidade canonica por
sessao, exigiria uma nova semantica de status/vinculo nos originais e ampliaria
o impacto para consumidores historicos. Manter ambos contabilizaveis foi
rejeitado porque duplica deterministicamente o dinheiro recebido.

**Consequencias:** o endpoint rejeita IDs duplicados, ausentes, pacientes ou
clinicas mistos antes de escrever; valida split contra o total calculado; rejeita
`partial` sem saldo restante explicito; usa escrita condicional dentro de
transacao para serializar concorrencia; e invalida caches somente apos commit.

### ADR-018: FinancialDailySnapshot removido do caminho de leitura do dashboard (mês fechado)

**Decisão:** `back/routes/financialDashboard.v2.js` (rota `GET /v2/financial/dashboard`) e `calculateComparativos()` no mesmo arquivo pararam de usar `financialSnapshotService`/`FinancialDailySnapshot` como atalho de leitura pra mês fechado. Receita (caixa/produção) agora é **sempre** recalculada ao vivo via `unifiedFinancialService.v2.js` (`calculateRealTime`), inclusive pra meses passados. Despesas continuam usando `financialExpenseSnapshotService` (entidade separada, sem evidência de problema — fora de escopo).

**Motivo:** Investigação de usuário (2026-09-11) — aba Metas de julho/2026 mostrava "Recebido da produção" e "Meta Realizada" com valores que pareciam não bater. Meta Realizada (R$34.260) estava **correta** (verificado rodando `calculateMetaRealizada` direto no banco: R$37.770 caixa − R$3.200 convênio retroativo − R$310 liminar = R$34.260). O problema real: `FinancialDailySnapshot` — já listado como entidade DEPRECATED nesta página (ver anti-patterns) — ainda era consumido como atalho de performance pra mês fechado, e auditoria mostrou o snapshot de julho capturando só **R$4.030 dos R$37.770 reais de caixa** (perdeu ~89% dos eventos `PAYMENT_STATUS_CHANGED`, 22 de 31 dias com dado) e superestimando produção (R$52.205 vs R$47.470 real). Só não afetou a tela até então porque a cobertura de dias (22/31 = 71%) ficou abaixo do gatilho de 80% em `isMonthlySnapshotReady()` — bomba-relógio: um backfill futuro que completasse mais dias do snapshot ativaria esse caminho quebrado silenciosamente. Achado um segundo bug independente no mesmo caminho: o código lia `data.producaoDetalhe.particularPendente`/`.pacotePendente` (campos que nunca existiram no formato retornado por `financialSnapshotService.getMonthlyAggregate()` — só existe um `pendente` agregado, sem quebra por particular/pacote), sempre resultando em zero e inflando artificialmente "Recebido da produção" pra mês fechado.

**Consequência:** (1) `calculateProfissionaisFromSnapshot()` removida (só existia pra esse caminho); (2) import de `financialSnapshotService` removido de `financialDashboard.v2.js`; (3) o worker (`workers/financialSnapshotWorker.v2.js`), o modelo `FinancialDailySnapshot` e os endpoints `POST /rebuild-snapshot` **continuam existindo** (não foram removidos nesta mudança — escopo foi só o lado de leitura do dashboard; investigar separadamente por que a captura de eventos está perdendo ~89% dos `PAYMENT_STATUS_CHANGED` antes de decidir se vale consertar o pipeline de escrita ou aposentá-lo de vez); (4) validado rodando o handler real da rota contra produção pós-fix: `source` sempre `real-time`, `particularPendente` deixou de ser zerado incorretamente, `metas.realizado.mes` bateu exato com `calculateMetaRealizada` (R$34.260). Scripts de auditoria/verificação: `back/scripts/audit-meta-realizada-julho-2026.mjs`, `back/scripts/verify-financial-dashboard-no-snapshot.mjs`.

### ADR-019: PatientBalance — reconciliação canônica no `paid` + escrita atômica sempre por operação, nunca `.save()` do documento inteiro

**Decisão:** (1) `transitionPaymentStatus()` ganhou opção opt-in `reconcilePatientBalance: true` — quando um Payment `particular` avulso (não `isFromPackage`/`package_consumed`) entra em `paid`, concilia automaticamente o débito de "sessão fiada" correspondente no `PatientBalance`. Match por `appointmentId`; se o Payment tem `session`, prefere o subconjunto de débitos que também bate por `sessionId` (vínculo mais específico — relevante em sinal+saldo, 2 Payments pro mesmo appointment). Nunca por `patientId`/coincidência de valor; mais de um débito aberto pro mesmo appointment (sem desempate por sessionId) não é resolvido automaticamente. Pagamento parcial nunca quita o débito inteiro — só incrementa `paidAmount`; `isPaid` só vira `true` quando o acumulado cobre o valor total. Ligado hoje só em `PATCH /api/v2/payments/:id` (`reason: 'admin_manual_patch'`); os ~20 outros call sites de `transitionPaymentStatus` não são afetados por padrão. (2) Todo `$push`/flip de `isPaid` em `PatientBalance.transactions` passou a ser feito via `updateOne` atômico com `runValidators: true` — nunca mais `patientBalance.save()` do documento inteiro, em nenhum dos 5 pontos do backend que já existiam (`incorporatePackagePayments()`, `settlePendingDebitsForPrepaidPackage()`, os dois blocos de quitação de débito em `createPackageV2` — reuso de appointment avulso e `selectedDebts`). Toda operação que marca um débito existente como pago usa **`$elemMatch`** pra escopar `_id`+`isPaid` no MESMO elemento do array — nunca dois campos soltos (`'transactions._id'`+`'transactions.isPaid'`), porque `$ne` num campo multikey verifica "nenhum elemento do array tem esse valor", não "este elemento não tem esse valor"; com 2+ débitos no array isso trava silenciosamente a quitação de qualquer um depois que outro já foi marcado pago (achado pelo teste `package-prepaid-settle-balance.test.js`, não por inspeção de código). (3) `routes/balance.v2.js` (`POST /:patientId/debit`) e `workers/balanceWorker.js` (`handleDebit`) passaram a validar `description`/`amount` antes de publicar e no consumidor, e a usar `idempotencyKey`/filtro de deduplicação determinístico (`patient+appointmentId`), nunca `Date.now()`/random; o filtro de duplicidade do worker exclui débitos com `isDeleted:true` — "1 appointment = 1 débito **ativo**", não "1 appointment = 1 débito para sempre", pra não bloquear permanentemente uma cobrança legítima nova depois de um estorno. (4) `incorporatePackagePayments()` também ganhou `__fromFinancialGuard`/`__guardContext` nos updates de `Appointment`/`Session` — sem essas flags o plugin `financialSanitizer` descartava silenciosamente `paymentStatus`/`isPaid` dessas escritas (bug pré-existente, não introduzido nesta correção, só descoberto pelo teste e2e: a sessão retroativa absorvida nunca ficava de fato "quitada" no Appointment mesmo com Payment/Package corretos).

**Motivo:** Investigação de bloqueio real em produção (2026-09-15, paciente Julia Boarati) — criação de pacote novo falhava com `PatientBalance validation failed: transactions.N.description: Path 'description' is required`, mesmo a sessão sendo absorvida não tendo nada a ver com os lançamentos quebrados. Causa raiz dupla: **(a)** `PATCH /:id` marcava `Payment.status='paid'` mas nunca tocava `PatientBalance` — nenhum código no repositório ligava "Payment virou paid" a "quitar o débito correspondente"; 3 sessões da paciente estavam pagas há semanas com débito aberto pra sempre. **(b)** `workers/balanceWorker.js::handleDebit()` escrevia via `PatientBalance.updateOne(...,{upsert:true})` **sem** `runValidators` e sem checar duplicidade — 5 lançamentos entraram sem `description` (schema exige) e duplicando débitos já existentes; ficaram invisíveis porque nenhuma escrita seguinte fazia `.save()` do documento inteiro — até `incorporatePackagePayments()` fazer exatamente isso pra registrar a quitação de uma sessão nova, e o Mongoose revalidar **o array inteiro**, não só o item novo (confirmado empiricamente: `validateModifiedOnly: true` não evita isso — push marca o array inteiro como modificado). `correlationId: null` nos 5 lançamentos bate com a assinatura de `handleDebit()` (único trecho que nunca setava esse campo) — isso demonstra que o worker **permitia** esse padrão de escrita quebrada, não é prova documental de que foi exatamente esse processo, numa execução específica de 25/08 ou 02/09, que os criou (não há log/evento residual de então pra confirmar com certeza).

**Consequência:** (1) Nenhum consumidor deve reintroduzir `patientBalance.save()` após um `.push()`/flip em `transactions`, nem usar `'transactions._id'`+`'transactions.isPaid'` como campos soltos — sempre `updateOne` com `$elemMatch` + `runValidators`. (2) Reparo dos dados da Julia foi **preparado em dry-run mas não aplicado em produção** — pendência aberta, exige autorização explícita antes de rodar: 4 duplicatas comprovadas (soft-delete), 3 débitos com Payment confirmado `paid` (quitação via credit, sem decrementar `totalDebited`), e duas pendências que **não são dedutíveis do dado** — 1 lançamento órfão sem vínculo nenhum (nenhuma origem atribuída) e a diferença de R$40 entre o débito original de R$200 (evidenciado no `financial_ledger` imutável) e o Payment de R$160 usado na absorção; o contexto informado foi "lançamento original incorreto de R$200 vs R$160 correto", não confirmado como desconto intencional — nenhuma das duas foi decidida unilateralmente. (3) `PatientBalance.addDebit()`/`revertDebitByAppointment()` (métodos do schema) continuam sem nenhum call site em produção — toda escrita real usa `updateOne`/`findOneAndUpdate` direto; não presumir que esses métodos são o caminho canônico só porque existem no model. (4) Testes: `tests/integration/incorporatePackagePayments.legacyLedger.test.js`, `tests/integration/paymentStatusService.reconcileBalance.test.js` (10 casos, incluindo pagamento parcial, sinal+saldo, desempate por sessionId, falha entre as duas escritas e concorrência real com duas transações Mongo simultâneas), `tests/unit/balanceWorker.handleDebit.test.js` (8 casos, incluindo concorrência real e desbloqueio pós-estorno), `tests/integration/createPackageV2.retroactiveAbsorption.e2e.test.js` (fim a fim, os dois valores de `calculationMode` — campo sem nenhum branch no backend, confirmado por grep — e falha intermediária sem persistência parcial).

### ADR-020: `generateInsurancePlanSessions.js` consultava campo inexistente (`appointment`) em vez de `appointmentId` — recriava Session a cada regeneração, orfanando a anterior

**Decisão:** `services/schedule/generateInsurancePlanSessions.js` corrigido — a checagem "este appointment já tem Session?" (antes de criar Sessions em lote, seção "7. Cria Sessions ANTES dos Payments") agora consulta `Session.find({ appointmentId: {...} })`, não `Session.find({ appointment: {...} })`. `Session` **nunca teve** campo `appointment` (só `appointmentId`, ver `models/Session.js`) — a query antiga sempre voltava vazia, então `existingSessionApptIds` era sempre um `Set` vazio e `appointmentsNeedingSession` sempre incluía **todo** appointment do plano, mesmo quem já tinha Session criada em uma chamada anterior.

**Motivo:** Investigação de conflito de agenda falso (2026-09-15, guia #16513883/Luiz — Mikaelly acusada de estar ocupada às 17:40 num dia errado, com dados de outro appointment). Rastreada até uma Session órfã do paciente Joaquim Rocha Simão (guia #16420444): `Session.appointmentId` apontava para um Appointment cujo próprio `Appointment.session` já apontava para uma Session **diferente**, mais nova. Auditoria completa (`Session` não-terminal com `appointmentId` setado, comparado contra `Appointment.session` do mesmo documento) encontrou **30 Sessions órfãs reais** (de 1418 candidatas, 1063 pareciam órfãs à primeira vista — 1028 delas eram na verdade outra categoria, ver item (3) abaixo) — 6 pacientes (Davi Felipe Araújo ×12, Joaquim Rocha Simão ×10, Helena Pedro Bezerra ×5, Joao Lucas Ribeiro de Santana ×1, Alencar Rafael Dos Santos Salgado Faria ×1, 1 sem paciente vinculado), datadas de abril a setembro/2026 — toda vez que o plano de algum desses pacientes foi editado/regenerado (troca de slot, "Gerar sessões" de novo, replan), a função recriava a Session do zero em vez de reconhecer a existente, repontando `Appointment.session` pra nova e deixando a antiga "scheduled" pra sempre — essas órfãs contam como ocupação real em `checkAppointmentConflicts`/`fetchOccupancyData` (que varre `Session` por `doctor`+`date`, sem checar se ainda é a session vigente do seu appointment), causando falsos-positivos de conflito de agenda com data/hora de uma Session que não reflete mais o agendamento real.

**Consequência:** (1) Bug de causa raiz corrigido — regeneração de plano a partir de agora reconhece Session existente e não duplica; (2) as 30 Sessions órfãs identificadas foram canceladas (`status: 'canceled'`, com nota de auditoria) via `back/scripts/maintenance` (script ad-hoc, não commitado — resultado documentado aqui); nenhum Appointment/Payment/Package foi tocado; (3) **os 1028 casos de `Session.appointmentId` apontando para Appointment inexistente foram investigados e fechados no mesmo dia — não são risco**: categoria distinta (referência pendurada por hard-delete de Appointment sem cascata, não duplicação por regeneração), mas **0 das 1028 têm data futura ou de hoje** (todas no passado; 968 nem têm `createdAt`, indicando dado bem antigo) — como todo conflito de agenda compara contra a data específica do novo agendamento, uma Session-fantasma datada no passado nunca pode colidir com nada marcado hoje ou no futuro. Não é pendência: é lixo histórico inerte, sem efeito prático, cuja única ação cabível seria limpeza de higiene de banco (não urgente, não afeta comportamento). O padrão de auditoria usado (comparar `Session.appointmentId` não-terminal contra `Appointment.session` do mesmo documento, separando "aponta pra outro" de "appointment não existe" de "Appointment.session é null", e depois checar se a data cai no passado ou no futuro) está validado e pode ser reaproveitado se o sintoma voltar; (4) mesma classe de bug já documentada no comentário de 2026-07-16 em `insuranceGuides.v2.js` (`PATCH /:id/appointments/doctor` não sincronizava Session) — ambos os casos são "algo escreve em Appointment/Session sem manter os dois em sincronia"; ao tocar qualquer fluxo de agenda de convênio, checar se a escrita usa `appointmentSessionSyncService.js` (regra de ouro: Appointment manda, Session segue) em vez de reimplementar sync ad-hoc.

---

## Changelog

| Data | Mudança |
|------|---------|
| 2026-09-15 | ADR-020: `generateInsurancePlanSessions.js` consultava campo `appointment` (inexistente em `Session`, só existe `appointmentId`) pra checar se já tinha Session — query sempre voltava vazia, recriava Session a cada regeneração de plano e deixava a anterior órfã, contando como ocupação falsa em conflito de agenda. 30 Sessions órfãs (6 pacientes, abril–setembro/2026) canceladas. Categoria relacionada (1028 casos de `appointmentId` pra Appointment inexistente) investigada e fechada no mesmo dia — todas datadas no passado, zero risco ativo |
| 2026-09-15 | ADR-019: PatientBalance nunca mais `.save()` do documento inteiro em nenhum dos 5 pontos do backend (sempre `updateOne` com `$elemMatch`+`runValidators` — `$elemMatch` corrigido depois de um bug real pego por teste, não por inspeção); reconciliação automática (opt-in) do débito de fiado quando Payment particular avulso entra em `paid` fora de fluxo dedicado, com desempate por `sessionId` e suporte a pagamento parcial/sinal+saldo; validação + idempotência determinística (exclui débitos revertidos) em `POST /v2/balance/:patientId/debit` e `balanceWorker.handleDebit()`; `financialSanitizer` bug pré-existente corrigido (Appointment/Session nunca ficavam de fato quitados na absorção retroativa). Causa raiz do bloqueio de criação de pacote da paciente Julia Boarati (transações legadas sem `description`, escrita compatível com o worker sem validação). Reparo dos dados da paciente preparado em dry-run, não aplicado |
| 2026-09-11 | ADR-018: removido atalho de `FinancialDailySnapshot` do dashboard financeiro (mês fechado) — snapshot de julho/2026 capturava só 11% do caixa real. Receita agora sempre ao vivo via `unifiedFinancialService`; despesas inalteradas (snapshot próprio, sem evidência de problema) |
| 2026-08-17 | Follow-up do incidente GMB de 2026-08-14: com o cron religado, boot log do `crm-worker` mostrou `CLOUDINARY_CLOUD_NAME/API_KEY/API_SECRET` ausentes nesse processo (só existiam no `crm-backend`) — geração de imagem nova falha até isso ser copiado no dashboard do Render. Auditoria do backlog real: 804 posts presos em `scheduled` (todos de 01–29/07, nenhum de agosto — geração também parou, não só o envio), 510 (63%) sem `mediaUrl`. Causa dos 510 sem imagem: `ImageBank` só tem 86 imagens cobrindo 6 especialidades (fonoaudiologia, terapia_ocupacional, psicomotricidade, musicoterapia, psicopedagogia, autismo=1) — zero cobertura para `psicologia`, `neuropsicologia`, `fisioterapia`, `freio_lingual`, `psicopedagogia_clinica`, `tdah`, `fono_adulto`, e zero para QUALQUER variante `*_anapolis` de landing page (o reúso busca pela especialidade base, essas variantes de tema nunca batem). Decisão do time: arquivar o backlog de julho (`status: cancelled`, tag `archived-july-backlog`, campo `error` documentando o motivo) em vez de publicar conteúdo de quase 1 mês atrás — reversível via a tag. **Pendência real para posts novos funcionarem:** (1) copiar `MAKE_WEBHOOK_URL`/`OPENAI_API_KEY`/`CLOUDINARY_*` do `crm-backend` pro `crm-worker` no Render; (2) a lacuna de cobertura do ImageBank continua — temas sem imagem no banco vão continuar dependendo de geração ao vivo (Cloudinary/OpenAI) até o banco ser ampliado |
| 2026-08-14 | Incidente: cron do GMB (geração diária de post + envio ao Make + republicação de expirados) órfão desde ~20/07. `server.js` desligou `scheduleGmbCron`/`scheduleGmbAutoRepublish` do processo web (comentário correto: geração de imagem bloqueia event loop de API/Socket.IO) com a intenção de "rodar no crm-worker", mas isso nunca foi de fato ligado em nenhum processo real — nem em `workers/startWorkers.js` nem em `cronManager.startAllCrons()` (que só roda dentro do próprio `server.js`). Mesma classe de erro do ADR-012 (item #24): ninguém confirmou o entrypoint real do `crm-worker` antes de assumir "vai rodar lá". Corrigido religando os dois crons em `workers/entrypoints/whatsapp-only.js` (Start Command real do crm-worker, processo parent — não o child do WhatsApp, para não competir com o Puppeteer). `scheduleLandingPageDailyPosts()` tem o mesmo problema e **continua órfão** (fora de escopo deste fix). **Nota de arquitetura (confirmado com o time em 2026-08-14):** `whatsapp-only.js` nasceu como workaround emergencial de um problema de conexão e virou o Start Command de fato por acomodação, não por design — o alvo de longo prazo é consolidar o WhatsApp de volta em `workers/startWorkers.js` (arquivo que o `render.yaml` já presume ser o rodando) e aposentar `whatsapp-only.js`/`whatsapp-child.js`. Migração NÃO feita neste fix — decisão explícita de escopo, dado o risco de derrubar a sessão WhatsApp real (#27) e a necessidade de trocar o Start Command no dashboard do Render. Se essa consolidação acontecer, mover o cron do GMB junto |
| 2026-08-07 | ADR-016: guard `assertNotProductionDb()` obrigatório em script/teste que escreve. Origem da contaminação identificada: `preparar-guia-para-teste-ui.mjs`, `manual-test-guide-closure.mjs`, `validar-fluxos-producao.js` e a suite `tests/e2e/v2` (7 arquivos) com URI de produção hardcoded. **Incidente de segurança no mesmo levantamento**: credencial do cluster Mongo em texto puro em 52 arquivos + 2 `.claude/settings*.json`, e a mesma senha usada na conta admin do CRM — removidas do código, **rotação pendente** |
| 2026-08-07 | ADR-015 + INVARIANTE 16 (financeira): `Payment.doctor` não é fonte de verdade para atribuição de profissional — resolver sempre por `Payment → Session → Session.doctor`. Auditoria: 440 payments sem doctor (268 pagos, R$ 51.320,01, 15 profissionais), 133/162 alertas de sessão órfã eram falso positivo, 3 divergências reais (R$ 360) mantidas como pendência operacional |
| 2026-08-06 | ADR-014: Package.frequencyInterval (weekly/biweekly, pacote quinzenal) — campo novo no write model não aparece automaticamente em PackagesView (projeção CQRS); precisa espelhar manualmente em schema + buildPackageView(). Mapa de impacto do Package atualizado com PackagesView e whitelists de sanitize (frontend/backend) |
| 2026-07-24 | ADR-013 RCA final: causa raiz identificada com alta confiança (WhatsApp Web renomeou id._serialized→id.$1). Hotfix aplicado: whatsapp-web.js pinado no fork lindionez#f4ea1e3 (patch da PR upstream #201832, ainda não mesclada oficialmente) — bridge temporário, trocar pro oficial quando mergear |
| 2026-07-24 | ADR-012 + checklist itens 7-10: toda fila BullMQ precisa de consumidor confirmado no entrypoint real de produção (não assumir por render.yaml). Invariantes #24-28 (Amanda): diagnóstico inicial errado (achou fila whatsapp-send sem consumidor — na verdade whatsapp-child.js sempre teve; Start Command real do crm-worker é whatsapp-only.js, não workers/startWorkers.js como o render.yaml sugere). Causa raiz real: sessão WhatsApp Web desconectada. whatsappPipelineGuard religado em server.js (processo que roda de fato) + checkWhatsappSendQueue() adicionado. CORS fix (allowedHeaders faltando Cache-Control/Pragma) |
| 2026-07-10 | ADR-011: projeção de caixa por lote retroativo (heurística de transição, thresholds configuráveis) |
| 2026-06-25 | ADR-010: KPI híbrido novaReceitaMes — regime de competência para convênio, caixa para particular/pacote |
| 2026-06-25 | billingMode per_month/per_guide: paidAt projetado em getInsuranceReceivables |
| 2026-06-23 | Criação — consolidação de invariantes, ADRs e mapas de impacto para entrada de qualquer IA |
