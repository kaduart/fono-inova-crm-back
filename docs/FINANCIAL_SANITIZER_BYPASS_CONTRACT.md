---
title: "Financial Sanitizer Bypass Contract"
tags: [financial-sanitizer, shadow-state, bypass, appointment, session, payment]
status: active
created: 2026-08-12
---

# Contrato de bypass do Financial Sanitizer

## O que o plugin faz

O plugin `models/plugins/financialSanitizer.js` é registrado nos schemas `Appointment` e `Session`. Ele impede que campos financeiros legados sejam persistidos na origem (CREATE / UPDATE), forçando o uso do ledger `Payment` como fonte de verdade (ADR-001).

Campos removidos:

- `isPaid`
- `paymentStatus`

## Hooks e onde leem a flag de bypass

| Hook | Fonte da flag | Quando dispara |
|---|---|---|
| `pre('save')` | `this.$locals` | `doc.save()`, `Model.create()`, `new Model()` |
| `pre('insertMany')` | `options` do terceiro argumento | `Model.insertMany(docs, options)` |
| `pre(['updateOne','updateMany','findOneAndUpdate'])` | `this.getOptions()` | Updates em massa e upserts |

As flags de bypass são consumidas pelos hooks de `insertMany` e de update (`updateOne`/`updateMany`/`findOneAndUpdate`), que as deletam do objeto `options`. **Sempre passe um objeto `options` novo por chamada nesses hooks**; reutilizar o mesmo objeto faz a segunda chamada perder o bypass silenciosamente. O hook `pre('save')` lê `this.$locals`, que é por documento, portanto não há vazamento entre chamadas.

## Formato da flag

```js
{
  __fromFinancialGuard: true,
  __guardContext: 'FINANCIAL'
}
```

## Regra de decisão: quando bypassar

Bypassar o sanitizer é exceção, não regra. A condição acumulativa é:

1. O call site grava um valor de negócio **não default** no campo; e
2. Existe um consumidor de leitura que depende desse valor para comportamento correto da tela/regra.

**Não bypassar** quando o valor é um estado espelhado derivável de `Payment` (por exemplo, marcar todas as sessões como `paid` só porque o pacote teve entrada de pagamento). Nesses casos o campo deve cair para o default do schema e a leitura deve consultar `Payment`/`Package.balance`.

## Casos reais registrados

### 1. Vazamento via `Model.$locals` (corrigido na Fase 2)

Antes do fix, o hook de `insertMany` lia `this.$locals` em vez de `options`. Uma única atribuição global vazava para todos os `insertMany` seguintes, fazendo bypasses indevidos.

- Evidência: `PLANS/APPOINTMENT_SHADOW_STATE_REMOVAL.md`
- Fix: hook passou a ler o terceiro argumento `options` e a remover as flags dele antes de chamar `next()`.

### 2. Convênio nascendo `pending` em vez de `pending_receipt`

`pending_receipt` não é o default do schema. Sem bypass, agendamentos/sessões de convênio nascem como `pending`, que é o status de débito do paciente.

- Consumidor: `routes/patient.js:333-337` e `:357-363` montam o débito do paciente filtrando `paymentStatus in ['pending','unpaid','pending_balance']`.
- Call sites autorizados: `services/schedule/generateInsurancePlanSessions.js:382` (Session, via `buildInsuranceSession` em `domain/session/sessionFactory.js:129`).
- Call site legado: `controllers/convenioPackageController.js:202` e `:232` também gravavam `pending_receipt`, mas o arquivo está descontinuado e será removido em PR própria.

### 3. Pacote parcialmente pago escondendo débito real

`utils/createNextPackageFromPrevious.js` (código morto, zero consumidores) marcava todas as sessões novas como `paid` de forma incondicional. Se bypassado, pacotes parcialmente pagos sumiriam do débito do paciente (`routes/patient.js:333-337` exclui `paid`).

- Decisão: não bypassar este call site. Como o arquivo não tem consumidor, o bypass foi removido.
- Fonte canônica: `Payment` e `Package.balance`.

## Módulos dependentes desta regra

- `controllers/packageController.v2.js` — `createAppointmentsBatch` / `createSessionsBatch` gravam `package_paid`/`unpaid` de acordo com o modelo do pacote e já usam bypass; **o settle do pacote em `:1786-1801` faz `updateMany` sem bypass, então continua sendo no-op silencioso e gerador de divergência (fora do escopo da Fase 2).**
- `services/schedule/generateInsurancePlanSessions.js` — grava `pending_receipt` para sessões de convênio e usa bypass.
- `services/appointmentSessionSyncService.js` — usa `Session.create()` e `findByIdAndUpdate` sem bypass; ainda gera divergência (Fase 3).
- `routes/patient.js` — principal consumidor de `Session.paymentStatus` para débito do paciente.

## Escopo atual e próximas fases

- **Fase 2 (este documento):** corrige `insertMany` e o vazamento de flags.
- **Fase 3:** corrigir caminhos `create()` / `save()` / `findByIdAndUpdate` que hoje perdem valores não default.

## Referências

- `models/plugins/financialSanitizer.js`
- `PLANS/APPOINTMENT_SHADOW_STATE_REMOVAL.md`
- `docs/AUDITORIA_STATUS_CONVENIO_LEGADO.md`
- `docs/FINANCIAL_SOURCE_OF_TRUTH.md`
