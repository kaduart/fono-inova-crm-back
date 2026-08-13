# Regras de Falta e Débito — Session / Appointment

> **Criado em:** 2026-08-13
> **Decisão:** Auditor de Negócio
> **Relacionado:** `docs/FINANCIAL_SANITIZER_BYPASS_CONTRACT.md`, `routes/patient.js:333-337`

---

## 1. Regra base

Toda sessão **realizada (`completed`)** ou **falta (`missed`)** com valor deve aparecer como débito até ser quitada.

A query canônica de débito é:

```js
Session.find({
  patient: patientId,
  paymentStatus: { $in: ['pending', 'unpaid', 'pending_balance'] },
  status: { $in: ['completed', 'missed'] }
});
```

Essa regra depende de `paymentStatus` estar presente com o valor `pending` (default do schema). O plugin `financialSanitizer` deve preservar esse default quando o call site não escreve explicitamente no campo.

---

## 2. Exceções

A clínica pode definir exceções formais para não cobrar uma falta:

| Situação | Como registrar | Efeito na query de débito |
|---|---|---|
| Falta justificada (atestado, reagendamento) | Flag específica ou status `cancelled`/`rescheduled` | Fora do filtro `status: { $in: ['completed', 'missed'] }` |
| Cortesia / perdão | Ajuste manual no `PatientBalance` e flag `isWaived` | Fora do filtro por `paymentStatus` ou excluída por flag |
| Pacote transferido nunca concluído | `paymentStatus: 'package_paid'` ou `pending` conforme decisão | Ver `docs/PACKAGE_CREDIT_TRANSFER.md` |

> **Importante:** não deve existir processo informal de "não cobrar faltas" sem registro no sistema. Processos informais precisam ser formalizados em flag ou status.

---

## 3. Impacto do PR-0

Entre 2026-04-29 e 2026-08-13, o plugin `financialSanitizer` estava apagando `paymentStatus` em documentos novos. Sessões `missed` criadas nesse período ficaram invisíveis na query de débito.

O PR-0 restaura o comportamento correto: sessões `missed` voltam a nascer com `paymentStatus: 'pending'` e a aparecer como débito.

### Comunicação operacional

- A secretaria deve ser avisada antes do deploy.
- Relatórios de inadimplência podem mostrar valores adicionais após o deploy e após o reparo de dados.
- O volume identificado é pequeno (R$ 150,10 em 8 sessões desde 29/04), mas a regra vale para todo registro futuro.

---

## 4. Riscos de dupla contagem

Dois endpoints podem retornar débitos do mesmo paciente:

- `GET /:patientId/sessions/pending` (`routes/patient.js:271`) — filtra por `paymentStatus` e `status`.
- `GET /:patientId/balance/details` (`routes/patient.js:395`) — retorna `PatientBalance`.

Hoje, nenhum consumidor de produção no frontend soma os dois. Qualquer tela nova que fizer isso deve tratar a interseção para evitar dupla contagem.

---

## 5. Reparo de dados

Sessões sem `paymentStatus` criadas entre 2026-04-29 e o deploy do PR-0 devem ser reparadas em PR separado:

- Sessões avulsas ou `missed` sem pacote → `paymentStatus: 'pending'`, `isPaid: false`.
- Sessões de pacote transferido confirmadas como quitadas → `paymentStatus: 'package_paid'`, `isPaid: true`.
- Sessões de pacote com dúvida → auditoria individual antes de aplicar qualquer valor.

O reparo deve ser:

- Idempotente.
- `dryRun` por padrão.
- Com evidência antes/depois.
- Fora do escopo: 240 sessões de 2025-07 a 2025-10 sem `paymentStatus` (dados anteriores ao plugin, provavelmente de convênio/caixa).
