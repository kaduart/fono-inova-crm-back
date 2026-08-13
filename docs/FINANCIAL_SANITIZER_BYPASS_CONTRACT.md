# Contrato de Bypass do Financial Sanitizer

> **Criado em:** 2026-08-13
> **Versão:** 1.0
> **Responsável:** Conselho Técnico — CRM Fono Inova

---

## 1. Propósito

O plugin `models/plugins/financialSanitizer.js` protege a **fonte única de verdade financeira** (`Payment` / `Package.balance`) bloqueando a persistência dos campos legados `isPaid` e `paymentStatus` quando eles são escritos diretamente por código de domínio.

Este documento define **quando e como** um call site pode solicitar bypass autorizado, e qual o comportamento esperado em cada caminho de escrita do Mongoose.

---

## 2. Flags de bypass

Toda escrita explícita em `isPaid` / `paymentStatus` deve justificar-se e carregar as flags:

```js
{
  __fromFinancialGuard: true,
  __guardContext: 'FINANCIAL'
}
```

As flags podem ser passadas:

- No **objeto `options`** de `Model.create`, `Model.insertMany`, `Model.updateOne`, `Model.updateMany`, `Model.findOneAndUpdate`.
- No **`this.$locals`** do documento, antes de `doc.save()`.

### Regra de decisão

> **Bypassar** apenas quando o call site está escrevendo um estado financeiro que **não é derivável de `Payment` no mesmo instante**.
>
> **Não bypassar** quando o valor é um estado espelhado derivável de `Payment` (por exemplo, marcar todas as sessões como `paid` só porque o pacote teve entrada de pagamento). Nesses casos o campo deve cair para o **default do schema** e a leitura deve consultar `Payment` / `Package.balance`.

---

## 3. Comportamento por caminho de escrita

| Caminho | Interceptado pelo sanitizer | Comportamento sem bypass | Observação |
|---|---|---|---|
| `Model.create` / `new Model().save()` (documento novo) | **Sim** | Valor explicitamente modificado cai para o **default do schema**. | `isDirectModified` distingue escrita explicita do default. |
| `doc.save()` em documento existente | **Não** | Escrita passa. | Não entra no escopo do hook `pre('save')` (condição `isNew`). |
| `Model.insertMany` | **Sim** | Valor cai para o **default do schema**. | Comportamento oráculo para o caminho `save`. |
| `Model.updateOne` / `updateMany` / `findOneAndUpdate` | **Sim** | Campo removido do `$set`; update vira no-op se só tinha ele. |  |
| `Model.bulkWrite` | **Não** | Escrita passa. | Buraco conhecido. Novas escritas financeiras devem evitar `bulkWrite`. |
| `Model.collection.*` (driver nativo) | **Não** | Escrita passa. | Usado por caminhos legados com campo marcador próprio (ex: `_fromCompleteService`). |

Três dos seis caminhos não são interceptados. Isso justifica uma **consolidação futura** dos mecanismos de bypass, mas é trabalho separado.

---

## 4. `save` / `create` — regra específica

O hook `pre('save')` atua **apenas em documentos novos** (`this.isNew`) e **apenas quando o campo foi explicitamente modificado** (`this.isDirectModified(field)`).

```js
if (this.isNew && this.isDirectModified(field)) {
  // loga o valor removido
  // substitui pelo default do schema, nunca por `undefined`
  this.set(field, this.schema.path(field).getDefault(this));
}
```

### Por quê?

- Os campos `isPaid` e `paymentStatus` possuem `default` no schema (`false` e `pending`).
- Se o call site **não tocou** no campo, ele deve nascer com o default, senão a query de débito (`paymentStatus: { $in: ['pending', 'unpaid', 'pending_balance'] }`) perde a linha.
- Se o call site **escreveu explicitamente** sem bypass, o valor é espelhado e deve cair para o default, preservando a regra de fonte única.
- Se o call site **escreveu explicitamente com bypass**, o valor é preservado.

---

## 5. Mecanismos de bypass hoje (não consolidados)

Hoje existem três mecanismos de fuga do sanitizer em produção:

1. **Flags `__fromFinancialGuard` / `__guardContext`** — mecanismo padrão deste contrato.
2. **`this.$locals` no documento** — usado em `insertMany` por `controllers/packageController.v2.js` (a ser migrado para options na Fase 2).
3. **Driver nativo com campo marcador** — `services/completeSessionService.v2.js:778` usa `Appointment.collection.updateOne` e persiste `_fromCompleteService: true`.

A consolidação em um único mecanismo é **oportunidade futura**; não entra no escopo de cada correção pontual.

---

## 6. Stack trace

O plugin loga a stack trace filtrada, removendo frames de `node_modules`, frames do próprio plugin (`models/plugins/financialSanitizer.js`) e mantendo as 5 primeiras frames restantes. O objetivo é deixar apenas frames de código de domínio, para que o log sirva para encontrar call sites que ainda escrevem shadow state.

```js
new Error().stack
  .split('\n')
  .filter(line =>
    line.includes('    at ') &&
    !line.includes('node_modules') &&
    !line.includes('models/plugins/financialSanitizer.js')
  )
  .slice(0, 5)
  .join('\n');
```

Isso remove o ruído do `kareem` (Mongoose middleware engine) e do próprio plugin. A chave de deduplicação (`stackKey`) usa `${entityName}:${operation}:${meta.stack}`; com o ruído removido, call sites diferentes deixam de ser colapsados em um único log, permitindo identificar origens distintas no pós-deploy. Quando o hook roda como callback de Promise, a stack pode conter apenas frames genéricas (ex: `at new Promise`), então o log serve como indicativo para cruzar com timestamps/endpoints.

---

## 7. Testes de caracterização

Testes obrigatórios para qualquer mudança neste plugin:

- `create` sem tocar em campo financeiro → documento com defaults.
- `create` com valor explicito e sem bypass → cai para default.
- `create` com valor explicito e bypass via options → preserva.
- `create` com array compartilhando o mesmo objeto de options → todos preservados.
- `save` com bypass via `this.$locals` → preservado.
- `insertMany` e `create` com mesma entrada → resultado idêntico.
- Sessão criada sem escrita financeira, depois `missed` → `paymentStatus: 'pending'` e aparece na query de débito.

Implementação atual: `models/plugins/__tests__/financialSanitizer.test.js`.

---

## 8. Read paths vivos que decidem quitação por pacote

A decisão de negócio de derivar a quitação por pacote de `Payment` / `Package.balance` só pode ser implementada na ordem correta. Remover a escrita antes de migrar a leitura recria o bug inverso: sessões já pagas aparecendo como débito do paciente (cobrança duplicada).

### Ordem obrigatória

1. **Primeiro:** migrar os read paths que decidem se uma sessão paga por pacote aparece como débito do paciente.
2. **Depois:** remover o espelho `paid` / `true` do `bulk-settle` em `routes/payment.v2.js:1663` e `:1676`.

### Read paths principais (vivo na tela da secretaria)

- `routes/appointmentReads.js:112` (`GET /patient/:id`) — alimenta calendário e tabela de agendamentos do paciente.
- `routes/appointmentReads.js:180-183` — derivação do `paymentStatus` com fallback para o campo cru:
  ```js
  paymentStatus: appt.package
    ? (appt.paymentStatus || 'package_paid')
    : (appt.paymentStatus === 'paid' ? 'paid' : appt.paymentStatus || 'pending')
  ```
- `dtos/appointment.response.dto.ts:110-112` (front) — camada equivalente de fallback.

### Read paths secundários (sem consumidor de produção no front)

- `routes/patient.js:271` (`GET /:patientId/sessions/pending`)
- `routes/patient.js:333-337` (query de débito do paciente)
- `routes/patient.js:395` (`/balance/details`)

Esses endpoints podem ser migrados, mas não mudam sozinhos o que a secretária vê.

### Fallback de leitura

`routes/appointmentReads.js:181` e o DTO do front usam fallback: quando o campo está ausente e o agendamento tem `package`, a tela mostra `package_paid`. Enquanto esse fallback existir, medições feitas apenas pelo banco distorcem o que a secretária vê. Qualquer reparo de dados deve levar esse fallback em conta, sob pena de criar débito indevido na tela para pacotes já quitos ou cobertos por crédito.

## 9. Regra de reparo de dados

Aplica-se a documentos criados após 29/04/2026 que nasceram sem `paymentStatus` por causa do bug do `delete` (comportamento corrigido pelo PR-0).

| Situação | Regra | Valor alvo |
|---|---|---|
| Documento **sem `package`** e sem escrita explícita | Volta para o default do schema. | `paymentStatus: 'pending'`, `isPaid: false` |
| Documento **com `package`** e sem escrita explícita | **Não entra na regra automática.** Vai para auditoria individual. | — |
| Transferência de crédito de pacote (`transferPackageCreditCommand`) | Bypass autorizado. | `paymentStatus: 'package_paid'`, `isPaid: true` |
| 5 sessões de pacote de 08/05 e 07/07 sem `paymentStatus` | Auditoria individual; provavelmente `package_paid`, desde que o pacote estivesse quitado, sem estorno posterior e não superseded. | `paymentStatus: 'package_paid'`, `isPaid: true` |

### Motivo do ramo por `package`

O fallback de `routes/appointmentReads.js:181` devolve `package_paid` quando o campo está ausente e o agendamento tem `package`. Se o reparo escrever `pending` nesses documentos, a tela passa a mostrar débito indevido para agendamentos de pacote. Em produção, 13 agendamentos com `package` e sem `paymentStatus` desde 29/04/2026 são exibidos hoje como `package_paid` pelo fallback; escrever `pending` neles criaria cobrança indevida na tela de agendamento do paciente (~R$ 1.360 exposto).

## 10. Call sites conhecidos que escrevem explicitamente

| Call site | Valor escrito | Bypass aplicado | Justificativa |
|---|---|---|---|
| `services/billing/commands/transferPackageCreditCommand.js` | `isPaid: true`, `paymentStatus: 'package_paid'` | Sim (options) | Sessão coberta por transferência de crédito de pacote. Não há `Payment` novo. |
| `routes/payment.v2.js` (estorno / deleção de payment) | `isPaid: false`, `paymentStatus: 'unpaid'` | Sim (options) | Reversão financeira com consumidor de leitura identificado. |
| `controllers/packageController.v2.js` settle-payments | `isPaid: true`, `paymentStatus: 'paid'` | **Não aplicar** | Valor espelhado derivável de `Payment` / `Package.balance`. Ler, não escrever. |
| `routes/payment.v2.js` bulk-settle | `isPaid: true`, `paymentStatus: 'paid'` | Passa via `bulkWrite` (buraco) | Deve ser resolvido pela leitura; não escrever `paid` na Session. |

> **Decisão de negócio (2026-08-13):** a quitação de débito por pacote deve ser derivada de `Payment` / `Package.balance` nas telas, e não espelhada em `Session.paymentStatus`. Por isso `settle-payments` e `bulk-settle` não recebem bypass e um trabalho de read path será feito separadamente.

---

## 11. Evolução

- **Curto prazo:** manter este contrato e adicionar bypass apenas em call sites que escrevem estado financeiro não derivável de `Payment`.
- **Médio prazo:** migrar os read paths de quitação por pacote para derivar de `Payment` / `Package.balance`, eliminando a necessidade de espelhar `paid` em `Session` / `Appointment` nesse fluxo. Ver Seção 8 — Ordem obrigatória.
- **Longo prazo:** consolidar os três mecanismos de bypass em um único modelo (preferencialmente options padronizado) e remover escritas pelo driver nativo.
