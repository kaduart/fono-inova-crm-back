# P2 — Diagnóstico: Por que as Read Models financeiras estão vazias?

> Data: 2026-07-30  
> Coleções analisadas: `PaymentsView`, `InsuranceGuideView`, `InsuranceBatchView`, `PackagesView`, `FinancialDailySnapshot`

---

## Resumo executivo

| Read Model | Documentos | Status | Causa principal |
|---|---|---|---|
| `FinancialDailySnapshot` | 239 | ✅ Funcionando | Atualizado inline por `financialSnapshotWorker.v2.js` chamado pelo `paymentWorker`. |
| `PackagesView` | 1 | ⚠️ Parcial | Worker registrado, mas criação também faz rebuild síncrono; poucos eventos na fila. |
| `PaymentsView` | **0** | ❌ Quebrado | **Incompatibilidade de eventos**: `paymentWorker` chama `paymentsProjection.js` com eventos antigos (`PAYMENT_CREATED`/`PAYMENT_UPDATED`), mas o pipeline atual publica `PAYMENT_COMPLETED` via worker e `PAYMENT_CREATED` via `billingConsumerWorker` sem chamar a projection. |
| `InsuranceBatchView` | **0** | ❌ Desligado | `insuranceOrchestratorWorker` está **desregistrado** no `registry.js` desde 2026-07-29. |
| `InsuranceGuideView` | **0** | ❌ Incompleto | Modelo existe, mas **não há worker/service de projeção**. Rota lê do `InsuranceGuide` transacional. |

Conclusão: **a arquitetura V2 existe, mas o "cabo" entre eventos e projeções não está ligado**. Não é necessário reescrever a arquitetura — é preciso conectar os fios e rodar rebuilds.

---

## 1. `PaymentsView` — por que está vazia?

### 1.1 O que deveria acontecer

Fluxo esperado:
```
Payment criado/atualizado
        ↓
Evento publicado (PAYMENT_CREATED / PAYMENT_UPDATED)
        ↓
Worker consome evento
        ↓
projections/paymentsProjection.js::handlePaymentEvent()
        ↓
PaymentsView.upsertFromPayment()
```

### 1.2 O que realmente acontece

Existem **dois caminhos conflitantes**:

#### Caminho A — `paymentWorker.js`

Arquivo: `back/workers/paymentWorker.js:257-269`

```js
// 🔄 ATUALIZA PAYMENTSVIEW (projection para tela de pagamentos)
try {
    const { handlePaymentEvent } = await import('../projections/paymentsProjection.js');
    await handlePaymentEvent({
        type: 'PAYMENT_CREATED',
        payload: { paymentId: payment._id.toString() },
        timestamp: new Date()
    });
} catch (projError) { ... }
```

Mas esse código só roda dentro do handler `handlePaymentRequested()` (fluxo antigo de `PAYMENT_REQUESTED`), que **não é o caminho V2 atual**.

#### Caminho B — `billingConsumerWorker.js`

Arquivo: `back/domains/billing/workers/billingConsumerWorker.js:317-347`

Publica `PAYMENT_CREATED` no barramento de eventos:
```js
await publishEvent(EventTypes.PAYMENT_CREATED, eventPayload, { ... });
```

**Mas não chama `handlePaymentEvent()` de `paymentsProjection.js`.**

Então o evento é publicado, mas ninguém o consome para atualizar a `PaymentsView`.

### 1.3 Onde a projeção escuta

Arquivo: `back/projections/paymentsProjection.js:20-23`

```js
switch (type) {
    case 'PAYMENT_CREATED':
    case 'PAYMENT_UPDATED':
    case 'PAYMENT_MARKED_AS_PAID':
        return await upsertPaymentProjection(payload.paymentId || payload._id);
```

A projection espera `PAYMENT_CREATED`, `PAYMENT_UPDATED` ou `PAYMENT_MARKED_AS_PAID`.

### 1.4 Incompatibilidade encontrada

| Publicador | Evento publicado | Chama `paymentsProjection.js`? | Resultado |
|---|---|---|---|
| `paymentWorker.js` (PAYMENT_REQUESTED) | `PAYMENT_CREATED` (inline) | ✅ Sim | Só no fluxo legado |
| `paymentWorker.js` (PAYMENT_COMPLETED) | `PAYMENT_COMPLETED` (BullMQ) | ❌ Não | Evento legado |
| `billingConsumerWorker.js` | `PAYMENT_CREATED` (BullMQ) | ❌ Não | Evento publicado, mas view não atualizada |
| `routes/payment.v2.js` | `PAYMENT_UPDATED` | ❌ Não | Evento publicado, mas view não atualizada |

### 1.5 Rebuild

Arquivo: `back/projections/paymentsProjection.js:104-145`

Existe `rebuildPaymentsProjection(clinicId)` e endpoint:
```
POST /api/v2/payments/rebuild
```

Mas **nunca foi executado em produção**.

### 1.6 Correção sugerida

Adicionar no `billingConsumerWorker.js` (após publicar `PAYMENT_CREATED`) e no `routes/payment.v2.js` (após publicar `PAYMENT_UPDATED`):

```js
const { handlePaymentEvent } = await import('../projections/paymentsProjection.js');
await handlePaymentEvent({
    type: 'PAYMENT_CREATED', // ou 'PAYMENT_UPDATED'
    payload: { paymentId: payment._id.toString() },
    timestamp: new Date()
});
```

Ou criar um worker dedicado à fila `patient-projection` / `v2:stats` (conforme `eventPublisher.js`) que chame `handlePaymentEvent`.

Depois rodar:
```bash
POST /api/v2/payments/rebuild
```

---

## 2. `InsuranceBatchView` — por que está vazia?

### 2.1 O que deveria acontecer

Fluxo esperado:
```
InsuranceBatch criado/enviado/recebido
        ↓
Evento INSURANCE_BATCH_*
        ↓
insuranceOrchestratorWorker consome
        ↓
updateInsuranceBatchView()
        ↓
InsuranceBatchView atualizada
```

### 2.2 O que realmente acontece

O worker `insuranceOrchestratorWorker` está **desregistrado** no `registry.js`.

Arquivo: `back/workers/registry.js:107-110`

```js
// insuranceOrchestratorWorker desregistrado em 2026-07-29: fila 'insurance-orchestrator'
// nunca recebe eventos reais (nenhum publisher de INSURANCE_BATCH_* ativo no pipeline em
// uso hoje). Código mantido em domains/billing/workers/insuranceOrchestratorWorker.js —
// ver investigação de arquitetura de convênio antes de reativar ou remover de vez.
```

Então:
- O código do worker existe e funciona.
- O worker **nunca sobe**.
- A `InsuranceBatchView` **nunca é atualizada**.

### 2.3 Rebuild

Arquivo: `back/domains/billing/services/InsuranceBatchProjectionService.js:133-158`

Existe `rebuildAllInsuranceBatchViews()`, mas **não há endpoint ou script de produção** que o chame.

### 2.4 Correção sugerida

Opção A — Reativar o worker:
```js
if (isEnabled('ENABLE_BILLING_INSURANCE_ORCHESTRATOR', true)) {
    const { startInsuranceOrchestratorWorker } = await import('../domains/billing/workers/insuranceOrchestratorWorker.js');
    workers.push(startInsuranceOrchestratorWorker());
}
```

Opção B — Rodar rebuild manual e manter worker desligado:
```bash
node -e "import('./back/domains/billing/services/InsuranceBatchProjectionService.js').then(m => m.rebuildAllInsuranceBatchViews())"
```

Recomendação: reativar o worker, mas garantir que os eventos `INSURANCE_BATCH_*` estejam sendo publicados pelo fluxo de convênio atual.

---

## 3. `InsuranceGuideView` — por que está vazia?

### 3.1 O que deveria acontecer

A documentação diz:
> GET /api/v2/insurance-guides/* → InsuranceGuideView

### 3.2 O que realmente acontece

Arquivo: `back/routes/insuranceGuides.v2.js`

A rota importa `InsuranceGuideView`:
```js
import InsuranceGuideView from '../models/InsuranceGuideView.js';
```

Mas a busca de guias é feita diretamente no modelo `InsuranceGuide`:
```js
InsuranceGuide.find({ ... })
```

**Não há service/worker de projeção para InsuranceGuideView.**

Arquivo: `back/docs/architecture/EVENT_PROJECTION_INVENTORY.md:196-204`

```
| Rebuild | Não encontrado |
| Status  | Sem mecanismo de recuperação documentado |
```

### 3.3 Correção sugerida

Criar:
1. `domains/billing/services/InsuranceGuideProjectionService.js` com `buildInsuranceGuideView(guideId)`.
2. Worker ou hook que chame a projeção em `INSURANCE_GUIDE_CREATED` / `INSURANCE_GUIDE_UPDATED`.
3. Script/endpoint de rebuild.

Ou, se a performance atual de leitura de guias for aceitável (são apenas 107 documentos), **remover o modelo `InsuranceGuideView` e simplificar**.

---

## 4. `PackagesView` — por que tem apenas 1 documento?

### 4.1 O que deveria acontecer

Fluxo esperado:
```
Package criado/atualizado
        ↓
Evento publicado na fila 'package-projection'
        ↓
packageProjectionWorker consome
        ↓
buildPackageView()
        ↓
PackagesView atualizada
```

### 4.2 O que realmente acontece

Arquivo: `back/workers/registry.js:103`

```js
if (isEnabled('ENABLE_BILLING_PACKAGE_PROJECTION')) workers.push(packageProjectionWorker);
```

O worker está registrado e deve subir.

Porém, a criação de pacote faz rebuild **síncrono**:

Arquivo: `back/controllers/packageController.v2.js:1195-1210`

```js
let viewBuildResult = null;
try {
    viewBuildResult = await buildPackageView(pkg._id.toString(), { correlationId });
} catch (viewError) { ... }
```

Isso explica o 1 documento: ele foi criado por uma chamada síncrona recente, não pelo worker.

### 4.3 Possíveis causas do worker não preencher

1. **Eventos não estão chegando na fila `package-projection`.**
2. **Fila vazia** porque o código de criação faz rebuild síncrono e não publica evento.
3. **Worker processou e falhou** silenciosamente (DLQ).

### 4.4 Correção sugerida

Verificar logs do worker e contagem de jobs na fila `package-projection`. Se a fila estiver vazia, o problema é publicação, não consumo.

---

## 5. `FinancialDailySnapshot` — por que funciona?

### 5.1 Pipeline atual

Arquivo: `back/workers/paymentWorker.js:106-113`

```js
const { processFinancialEvent } = await import('./financialSnapshotWorker.v2.js');
processFinancialEvent(eventType, payload).catch(err => ...);
```

Toda vez que um pagamento é processado pelo `paymentWorker`, o snapshot é atualizado **inline**.

### 5.2 Rebuild

Arquivo: `back/workers/financialSnapshotWorker.v2.js:307-394`

Existe `rebuildSnapshotForDate()` e `rebuildSnapshotRange()`.

O snapshot tem 239 documentos porque o pipeline inline funciona. Ele é o exemplo de sucesso da arquitetura V2.

---

## 6. Tabela de decisões

| Read Model | Decisão | Esforço | Impacto |
|---|---|---|---|
| `PaymentsView` | Conectar `billingConsumerWorker` e `payment.v2.js` à projection; rodar rebuild | Médio | 🔥 Alto |
| `InsuranceBatchView` | Reativar `insuranceOrchestratorWorker` no registry; rodar rebuild | Baixo | 🔥 Alto |
| `InsuranceGuideView` | Criar projeção + worker OU remover modelo | Médio | Médio |
| `PackagesView` | Verificar fila + publicação de eventos; garantir worker ativo | Baixo | Médio |
| `FinancialDailySnapshot` | Manter como está | Nenhum | — |

---

## 7. Próximos passos recomendados

1. **P3 — Ligar `PaymentsView`**
   - Adicionar chamada a `handlePaymentEvent()` no `billingConsumerWorker.js` após `PAYMENT_CREATED`.
   - Adicionar chamada em `routes/payment.v2.js` após `PAYMENT_UPDATED`.
   - Rodar `POST /api/v2/payments/rebuild` em produção.

2. **P4 — Ligar `InsuranceBatchView`**
   - Reativar worker no registry (com feature flag).
   - Publicar eventos `INSURANCE_BATCH_CREATED` no fluxo de criação de lote.
   - Rodar `rebuildAllInsuranceBatchViews()`.

3. **P5 — Decidir `InsuranceGuideView`**
   - Criar projeção e worker OU remover modelo se não for necessário.

4. **P6 — Validar `PackagesView`**
   - Verificar jobs na fila `package-projection`.
   - Garantir que eventos sejam publicados na fila (além do rebuild síncrono).
