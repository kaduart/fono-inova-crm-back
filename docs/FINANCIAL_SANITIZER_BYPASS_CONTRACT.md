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

O plugin loga a stack trace filtrada, removendo frames de `node_modules` e mantendo as 5 primeiras frames restantes.

```js
new Error().stack
  .split('\n')
  .filter(line => line.includes('    at ') && !line.includes('node_modules'))
  .slice(0, 5)
  .join('\n');
```

Isso remove o ruído do `kareem` (Mongoose middleware engine), mas ainda pode não conter o call site exato quando o hook roda como callback de Promise. Serve como indicativo para cruzar com timestamps/endpoints.

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

## 8. Call sites conhecidos que escrevem explicitamente

| Call site | Valor escrito | Bypass aplicado | Justificativa |
|---|---|---|---|
| `services/billing/commands/transferPackageCreditCommand.js` | `isPaid: true`, `paymentStatus: 'package_paid'` | Sim (options) | Sessão coberta por transferência de crédito de pacote. Não há `Payment` novo. |
| `routes/payment.v2.js` (estorno / deleção de payment) | `isPaid: false`, `paymentStatus: 'unpaid'` | Sim (options) | Reversão financeira com consumidor de leitura identificado. |
| `controllers/packageController.v2.js` settle-payments | `isPaid: true`, `paymentStatus: 'paid'` | **Pendente** | Caso contraexemplo do contrato; requer decisão de negócio para espelhar ou derivar. |
| `routes/payment.v2.js` bulk-settle | `isPaid: true`, `paymentStatus: 'paid'` | Passa via `bulkWrite` | Deve ser decidido junto com settle-payments. |

---

## 9. Evolução

- **Curto prazo:** manter este contrato e adicionar bypass apenas em call sites que escrevem estado financeiro não derivável de `Payment`.
- **Médio prazo:** migrar todos os consumidores de leitura para consultar `Payment` / `Package.balance`, eliminando a necessidade de shadow state em `Session` / `Appointment`.
- **Longo prazo:** consolidar os três mecanismos de bypass em um único modelo (preferencialmente options padronizado) e remover escritas pelo driver nativo.
