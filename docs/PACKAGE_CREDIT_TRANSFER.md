# Transferência de Crédito de Pacote — Exceção ao Invariante Financeiro

> **Criado em:** 2026-08-13
> **Decisão:** Conselho Técnico + Auditor de Negócio
> **Relacionado:** `docs/FINANCIAL_SANITIZER_BYPASS_CONTRACT.md`, ADR-001

---

## 1. Resumo do fluxo

`services/billing/commands/transferPackageCreditCommand.js` converte sessões **contratadas e não realizadas** de um pacote para outro, levando a cobertura já paga.

Caso de origem (2026-08-12): pacote de 8 sessões de fono, R$ 1.440 pagos antecipadamente. Duas realizadas, duas mantidas, quatro redirecionadas para psicologia por decisão da equipe. O dinheiro já entrou — o que muda é o que será entregue.

---

## 2. Por que é exceção ao invariante "Payment é fonte canônica"

O fluxo **não cria um novo `Payment`**. As sessões de destino nascem cobertas pelo crédito que já foi recebido no pacote de origem. Portanto, não existe `Payment` vinculado a essas sessões no momento da criação.

Como ainda precisamos rastrear que a sessão está coberta, usamos o snapshot legado autorizado:

```js
{
  isPaid: true,
  paymentStatus: 'package_paid',
  paymentOrigin: 'package_prepaid'
}
```

Esse é o único caso em que `Session` / `Appointment` nascem com `paymentStatus` sem um `Payment` próprio.

---

## 3. Bypass autorizado

As flags do sanitizer são passadas via `options` no `Model.create`:

```js
await Appointment.create([{ ... }], {
  session: mongoSession,
  __fromFinancialGuard: true,
  __guardContext: 'FINANCIAL'
});

await Session.create([{ ... }], {
  session: mongoSession,
  __fromFinancialGuard: true,
  __guardContext: 'FINANCIAL'
});
```

Isso preserva `isPaid: true` e `paymentStatus: 'package_paid'` na criação.

---

## 4. Correção natural ao completar

Quando a sessão de destino é concluída pelo fluxo normal:

- `services/completeSession/handlers/particularHandler.js` escreve `paymentStatus: 'package_paid'`.
- `services/completeSessionService.v2.js` faz update com as flags `__fromFinancialGuard` / `__guardContext`.

Ou seja: mesmo que a sessão nascesse sem bypass (caindo para `pending`), a conclusão a corrigiría para `package_paid`. O bypass na criação evita a janela intermediária.

---

## 5. Riscos e regras

1. **Sessão nunca concluída:** se a sessão de destino nunca for concluída, ela permanece como `pending` (ou `package_paid` se o bypass foi aplicado). A clínica deve decidir se o crédito transferido gera débito em caso de falta.
2. **Pacote de origem estornado depois:** se o pacote de origem for estornado, as sessões de destino não podem continuar como `package_paid`. O reparo deve identificar esses casos.
3. **Dupla contagem:** sessões `package_paid` não devem aparecer como débito em relatórios de inadimplência.
4. **Reparo retroativo:** as sessões sem `paymentStatus` criadas por transferências anteriores a este fix devem ser revisadas individualmente antes de receber `package_paid`.

---

## 6. Consumidores de leitura

Qualquer tela que liste sessões de pacote deve considerar:

- `paymentStatus === 'package_paid'`
- `paymentOrigin === 'package_prepaid'`
- `transferId` preenchido

Não confundir com `paymentStatus: 'pending'` de sessão avulsa não paga.

---

## 7. Evolução

Médio prazo: quando o modelo financeiro evoluir para não depender de shadow state, este snapshot deve ser substituído por uma relação canônica entre `Session`, `Package` e o histórico de crédito transferido.
