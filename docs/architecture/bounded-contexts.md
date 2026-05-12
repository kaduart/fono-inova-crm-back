# Bounded Contexts — CRM Fono Inova

> Documento de referência arquitetural.
> **Ler antes de expandir `syncAffectedViews` ou criar novos eventos de domínio.**

---

## Por que este documento existe

O sistema evoluiu de CRUD simples para CQRS parcial com projections denormalizadas.
Esse crescimento criou um risco específico: **side effects cruzando bounded contexts silenciosamente**.

Exemplo do bug que motivou este documento (2026-05-12):
- PUT `/appointments/:id` atualizava `Session` corretamente no banco
- Mas `PackagesView` (snapshot denormalizado lido pelo frontend) ficava stale
- Diagnóstico: `buildPackageView` não era chamado em 4 dos 7 handlers de mutation
- Fix imediato: centralizar em `syncAffectedViews`
- Fix estrutural: este documento — para que o próximo dev saiba ONDE e POR QUÊ sincronizar

---

## Bounded Contexts

### 1. Scheduling
**Responsabilidade:** criar, reagendar, confirmar, cancelar agendamentos na agenda clínica.

| Item | Valor |
|---|---|
| Aggregates | `Appointment`, `Session` |
| Source of truth | `appointments`, `sessions` collections |
| Projection própria | — (usa PackagesView indiretamente) |
| Eventos emitidos | `appointment.*` (ver tabela abaixo) |
| Não deve tocar | saldo financeiro, lote de convênio, contrato liminar |

---

### 2. TherapyPackage (Pacote Particular)
**Responsabilidade:** controlar sessões de pacotes pré-pagos particulares (full/partial).

| Item | Valor |
|---|---|
| Aggregates | `Package`, `Session` |
| Source of truth | `packages`, `sessions` collections |
| Projection crítica | `PackagesView` — alimenta agenda, edição, métricas |
| Eventos consumidos | `appointment.*` do contexto Scheduling |
| Não deve tocar | lotes de convênio, contratos liminares, avaliações avulsas |

**Regra de consistência:** `PackagesView` é projection **operacional** (não cache opcional).
Stale nela = sistema parece quebrado para o usuário.
Rebuild deve ser **síncrono e imediato** antes do response HTTP.

---

### 3. Financial (Pagamentos)
**Responsabilidade:** registrar e baixar pagamentos, controlar saldo do paciente.

| Item | Valor |
|---|---|
| Aggregates | `Payment`, `PatientBalance` |
| Source of truth | `payments`, `patient_balances` collections |
| Projection crítica | `FinancialLedger` (V2) |
| Eventos emitidos | `payment.settled`, `payment.refunded`, `balance.updated` |
| Não deve tocar | structure de pacote, lote de convênio |

**Atenção:** `Payment` pertence a Financial, não a TherapyPackage.
Um payment update **nunca** deve rebuildar `PackagesView` diretamente —
deve emitir `payment.settled` e o TherapyPackage decidir se reconhece.

---

### 4. Insurance (Convênio)
**Responsabilidade:** autorização de guias, faturamento em lote, glosa.

| Item | Valor |
|---|---|
| Aggregates | `InsuranceBatch`, `InsuranceGuide` |
| Source of truth | `insurance_batches`, `insurance_guides` collections |
| Projection crítica | `InsuranceBatchProjection` |
| Eventos emitidos | `insurance.batch_paid`, `insurance.guide_denied` |
| Não deve tocar | pacotes particulares, saldo de paciente particular |

**Atenção crítica:** convênio aprovado parcialmente ≠ sessão paga ≠ saldo consumido.
Nunca usar o mesmo handler de projection de TherapyPackage para convênio.

---

### 5. Liminar
**Responsabilidade:** sessões autorizadas por processo judicial, controle de crédito liminar.

| Item | Valor |
|---|---|
| Aggregates | `LiminarContract` |
| Source of truth | `liminar_contracts` collection |
| Projection crítica | própria do contrato |
| Eventos emitidos | `liminar.session_authorized`, `liminar.credit_consumed` |
| Não deve tocar | pacotes particulares, convênio |

---

### 6. Clinical
**Responsabilidade:** prontuário, status clínico, evolução do paciente.

| Item | Valor |
|---|---|
| Aggregates | `Session` (lado clínico), `Patient` |
| Source of truth | `sessions`, `patients` collections |
| Projection crítica | `PatientsView` (alimenta lista de pacientes) |
| Sincronização | `patientProjectionWorker` (async via event bus) |
| Não deve tocar | financeiro, estrutura de pacote |

**Nota:** `PatientsView` usa consistência **eventual (async)** — aceitável para lista de pacientes.
`PackagesView` usa consistência **imediata (sync)** — obrigatório para agenda operacional.
Esses dois modelos **não devem ser unificados**.

---

### 7. Evaluation (Avaliação)
**Responsabilidade:** sessões de avaliação avulsa, que não pertencem a pacote.

| Item | Valor |
|---|---|
| Aggregates | `Appointment` (serviceType: 'evaluation') |
| Source of truth | `appointments` collection |
| Projection | nenhuma própria — não rebuilda PackagesView |
| Não deve tocar | PackagesView, saldo de pacote, lote de convênio |

---

## Mapa de Eventos × Domínios

| Evento | Domínio dono | Projections afetadas | Sincronia |
|---|---|---|---|
| `appointment.updated` | Scheduling | PackagesView (se tem package) | **síncrona** |
| `appointment.rescheduled` | Scheduling | PackagesView (se tem package) | **síncrona** |
| `appointment.completed` | Scheduling | PackagesView (se tem package) | **síncrona** |
| `appointment.cancelled` | Scheduling | PackagesView (se tem package) | **síncrona** |
| `appointment.confirmed` | Scheduling | PackagesView (se tem package) | **síncrona** |
| `appointment.deleted` | Scheduling | PackagesView (se tinha package) | **síncrona** |
| `appointment.reverted` | Scheduling | PackagesView (se tem package) | **síncrona** |
| `payment.settled` | Financial | — (TherapyPackage decide) | eventual |
| `insurance.batch_paid` | Insurance | InsuranceBatchProjection | eventual |
| `liminar.session_authorized` | Liminar | LiminarProjection | eventual |
| `session.clinical_updated` | Clinical | PatientsView | **eventual** |

---

## `syncAffectedViews` — Escopo e Restrições

**Arquivo:** `back/services/projections/syncAffectedViews.js`

**Escopo atual (2026-05-12):**
- Somente eventos do contexto **Scheduling × TherapyPackage**
- Somente rebuild de `PackagesView`
- Chamado quando `appointment.package` existe (caller garante contexto)

**Regras para expandir:**
1. Novo evento → novo contexto → nova seção neste documento primeiro
2. Nunca mapear `payment.*` → `packages` diretamente
3. Nunca mapear eventos de Insurance ou Liminar para handlers de TherapyPackage
4. Cada domínio terá seu próprio registry quando escalar (ex: `billingProjectionRegistry`)

**Sinal de alerta:** se um handler em `syncAffectedViews` precisar checar
`if (appointment.billingType === 'convenio')` — é sinal de que cruzou um bounded context.
Pare e crie um handler separado.

---

## Projections × Consistência

| Projection | Domínio | Consistência | Motivo |
|---|---|---|---|
| `PackagesView` | TherapyPackage | **Imediata (sync)** | Alimenta UI operacional — stale = sistema quebrado |
| `PatientsView` | Clinical | Eventual (async worker) | Lista de pacientes tolera delay de segundos |
| `FinancialLedger` | Financial | Imediata (sync) | Saldo incorreto = erro crítico |
| `InsuranceBatchProjection` | Insurance | Eventual (async) | Lote processa em background |

---

## Checklist para nova mutation

Antes de criar ou modificar um endpoint de mutation, responda:

- [ ] Qual bounded context essa mutation pertence?
- [ ] Qual aggregate é a source of truth?
- [ ] Existe alguma projection que depende desse dado?
- [ ] Essa projection exige consistência imediata ou eventual?
- [ ] O evento emitido é semanticamente rico (ex: `therapy_package.session_rescheduled`) ou genérico demais (ex: `updated`)?
- [ ] O handler de sync está no registry do domínio correto, sem cruzar contexts?
