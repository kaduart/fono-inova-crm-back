# Regras Arquiteturais — CRM

> **Versão:** 1.1  
> **Data:** 2026-07-08  
> **Aplicação:** Todas as PRs que toquem em agendamentos, billing, pacotes, convênio ou read models.

---

## 1. Um único fluxo por responsabilidade

Para cada operação de negócio existe **apenas um** caminho oficial.

| Operação | Caminho oficial |
|----------|-----------------|
| Criar agendamento | `POST /api/v2/appointments` → `createAppointmentCommand` |
| Completar agendamento | `PATCH /api/v2/appointments/:id/complete` → `completeSessionService.v2` |
| Atualizar agendamento | `PATCH /api/v2/appointments/:id` → `updateAppointmentCommand` |
| Ler pacientes | `GET /api/v2/patients/*` → `PatientsView` |
| Ler pacotes | `GET /api/v2/packages/*` → `PackagesView` |
| Ler pagamentos | `GET /api/v2/payments/*` → `PaymentsView` |

**Não criar:** rotas paralelas, endpoints alternativos, ou commands duplicados para a mesma operação.

---

## 2. Um único endpoint por operação

Não é permitido ter:

- `POST /complete` e `POST /complete-insurance` e `PATCH /complete`
- `POST /appointments` e `POST /appointments/v2` e `POST /appointments/create`

**Deve existir apenas um endpoint por operação.**

---

## 3. Um único detector de billing

O backend é a única fonte de verdade para determinar se um agendamento é:

- `particular`
- `convenio`
- `liminar`

O frontend pode **exibir** a informação, mas não pode **decidir** o billing a ser enviado ao backend.

---

## 4. Um único contrato de resposta

Endpoints do mesmo domínio devem retornar contratos previsíveis. Não é permitido:

- Retornar `appointment` em um e `data.appointment` em outro
- Retornar `billingType` como string em um e como enum em outro
- Incluir campos extras em um endpoint e omitir em outro sem justificativa

Use DTOs e normalizadores compartilhados.

---

## 5. Nenhum fallback permanente

Fallbacks e feature flags são ferramentas de **rollout**, não de arquitetura.

- Após rollout confirmado, o fallback deve ser removido.
- Não deixar código do tipo `if (flag) { novo } else { legado }` por mais de 30 dias sem plano de remoção.

---

## 6. Nenhuma implementação paralela

Não manter duas implementações do mesmo handler.

❌ `handler-v1.js` + `handler-v2.js`  
❌ `service.js` + `service.optimized.js` + `service.event-driven.js`

✅ Apenas `handler.js` oficial.

---

## 7. Writes via commands/services; reads via views

- **Escrita:** commands/services → models → eventos → projeções
- **Leitura:** views / read models

Não colocar lógica de escrita em endpoints de leitura.

## 8. Pipeline de eventos obrigatório: Outbox → Dispatcher → BullMQ

Toda alteração de domínio que deva refletir em projeções deve seguir obrigatoriamente:

```text
Transaction MongoDB
    ↓
Outbox.save()  (saveToOutbox)
    ↓
OutboxDispatcher
    ↓
BullMQ
    ↓
Projection Worker
    ↓
Read Model
```

### Proibido

- Publicar eventos diretamente para BullMQ (`publishEvent`) a partir de código de domínio, controllers ou routes.
- Gravar eventos no `EventStore` como mecanismo de publicação (`appendEvent`).
- Atualizar ReadModels diretamente fora dos Projection Workers.
- Adicionar novos `EventTypes` ao catálogo se não forem publicados e consumidos imediatamente (use `events/EVENT_TYPES_ROADMAP.js` para eventos futuros).

### API pública do domínio

```js
import { saveToOutbox } from '../infrastructure/outbox/outboxPattern.js';

await saveToOutbox({
  eventType: 'APPOINTMENT_COMPLETED',
  payload: { appointmentId, patientId, ... },
  aggregateType: 'appointment',
  aggregateId: appointmentId
}, mongoSession);
```

### API interna

`publishEvent` e `appendEvent` são infraestrutura interna. Não devem ser chamados por código de domínio, controllers, routes, models ou workers. O único ponto autorizado a publicar eventos no BullMQ é o `OutboxDispatcher`, que lê da collection `outboxes`.

---

## 9. Legado deve ser explícito

Arquivos fora do fluxo canônico devem carregar um cabeçalho claro:

```ts
/**
 * @deprecated
 *
 * NÃO FAZ PARTE DO FLUXO CANÔNICO.
 *
 * Mantido apenas para rollback temporário.
 *
 * Não implementar novas features aqui.
 *
 * Fluxo oficial:
 * docs/architecture/CANONICAL_FLOW.md
 * docs/architecture/CANONICAL_FILES.md
 */
```

---

## 10. Documentação obrigatória para mudanças arquiteturais

Toda PR deve responder:

> **"Este PR altera a arquitetura?"**

- Se **não**, nenhuma documentação arquitetural precisa mudar.
- Se **sim**, `ARCHITECTURE.md` e os documentos canônicos devem ser atualizados no mesmo PR.

Uma PR altera a arquitetura se ela:

- cria uma nova rota,
- altera o contrato de um endpoint existente,
- introduz um novo handler de billing,
- muda a fonte de verdade de um read model,
- adiciona/remove um worker,
- ou muda o pipeline de eventos.

Documentos a atualizar quando aplicável:

- `ARCHITECTURE.md`
- `docs/architecture/CANONICAL_FLOW.md`
- `docs/architecture/CANONICAL_FILES.md`
- `docs/architecture/EVENT_PROJECTION_INVENTORY.md`

---

## 11. Checklist antes de abrir PR

- [ ] O arquivo que estou editando está em `CANONICAL_FILES.md` ou foi marcado como legado?
- [ ] Não criei rota/endpoint paralelo?
- [ ] O frontend não está decidindo billing?
- [ ] Não deixei fallback sem data de remoção?
- [ ] Atualizei a documentação canônica se necessário?
- [ ] Não adicionei `EventTypes` mortos ao catálogo?
- [ ] Não chamei `publishEvent`/`appendEvent` fora do dispatcher?
- [ ] Se toquei em projeção, usei o worker canônico e não `syncAffectedViews` direto?
- [ ] Se criei um worker, ele está registrado em `workers/registry.js`?

---

## Links

- [`CANONICAL_FLOW.md`](./CANONICAL_FLOW.md)
- [`CANONICAL_FILES.md`](./CANONICAL_FILES.md)
