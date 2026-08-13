# Regras de Falta e Débito — Session / Appointment

> **Criado em:** 2026-08-13
> **Decisão:** Auditor de Negócio
> **Relacionado:** `docs/FINANCIAL_SANITIZER_BYPASS_CONTRACT.md`, `routes/patient.js:333-337`

---

## 1. Comportamento técnico atual da query de débito

A query atual em `routes/patient.js:333-337` lista como débito toda sessão com:

```js
Session.find({
  patient: patientId,
  paymentStatus: { $in: ['pending', 'unpaid', 'pending_balance'] },
  status: { $in: ['completed', 'missed'] }
});
```

Isso faz com que, **hoje, tecnicamente**, sessões `missed` com `paymentStatus: 'pending'` apareçam na dívida do paciente. Esse comportamento é da query, não é regra de negócio aprovada.

Essa query depende de `paymentStatus` estar presente com o valor `pending` (default do schema). O plugin `financialSanitizer` deve preservar esse default quando o call site não escreve explicitamente no campo, para que documentos novos não fiquem invisíveis na query.

---

## 2. Regra de negócio aprovada sobre falta

> **Decisão do Auditor de Negócio (2026-08-13):** `missed` descreve o atendimento, não define cobrança. **Falta não gera débito automático.**

A cobrança depende da regra aplicada ao caso:

| Situação | Deve gerar débito? | Justificativa |
|---|---|---|
| Falta/cancelamento fora do prazo em pacote | Não gera débito extra, mas pode consumir crédito | Política do pacote |
| Cancelamento antecipado | Não | Há tempo de reagendar |
| Avaliação inicial | Não | Sem penalidade automática |
| Sessão avulsa marcada como `missed` | Não, por `missed` sozinho | Status não define cobrança |
| Ausência do profissional | Jamais | Responsabilidade da clínica |

A consulta de débitos deve evoluir para considerar evidência real de cobrança/consumo, e não apenas `Session.status`. Critérios esperados:

- tipo de sessão (avaliação, pacote, avulsa);
- prazo de cancelamento;
- evidência de pagamento ou consumo de crédito;
- ausência do profissional;
- política do pacote.

Até essa revisão entrar, o PR-0 deixa o estado intermediário técnico visível: faltas aparecem como débito na tela, mas **isso não é ordem de cobrança**.

---

## 3. Exceções formais

A clínica pode definir exceções para não cobrar uma falta:

| Situação | Como registrar | Efeito na query de débito |
|---|---|---|
| Falta justificada (atestado, reagendamento) | Flag específica ou status `cancelled`/`rescheduled` | Fora do filtro `status: { $in: ['completed', 'missed'] }` |
| Cortesia / perdão | Ajuste manual no `PatientBalance` e flag `isWaived` | Fora do filtro por `paymentStatus` ou excluída por flag |
| Pacote transferido nunca concluído | `paymentStatus: 'package_paid'` ou `pending` conforme decisão | Ver `docs/PACKAGE_CREDIT_TRANSFER.md` |

> **Importante:** não deve existir processo informal de "não cobrar faltas" sem registro no sistema. Processos informais precisam ser formalizados em flag ou status.

---

## 4. Impacto do PR-0

Entre 2026-04-29 e 2026-08-13, o plugin `financialSanitizer` estava apagando `paymentStatus` em documentos novos. Sessões `missed` criadas nesse período ficaram invisíveis na query de débito.

O PR-0 restaura o **default técnico**: sessões `missed` voltam a nascer com `paymentStatus: 'pending'`. Por isso passam a aparecer na query atual.

> **Importante:** o PR-0 não implementa a regra de cobrança. Ele corrige a perda do campo `paymentStatus`. A regra de negócio — falta não gera débito automático — será aplicada numa mudança posterior da consulta de débitos, não neste PR.

### Comunicação operacional

- A secretaria deve ser avisada antes do deploy.
- **Falta aparecendo como débito não é ordem de cobrança** até a query de débito ser ajustada.
- Relatórios de inadimplência podem mostrar valores adicionais após o deploy e após o reparo de dados.
- O volume identificado é pequeno (R$ 150,10 em 8 sessões desde 29/04), mas o campo volta a ser preenchido para todo registro futuro.

---

## 5. Riscos de dupla contagem

Dois endpoints podem retornar débitos do mesmo paciente:

- `GET /:patientId/sessions/pending` (`routes/patient.js:271`) — filtra por `paymentStatus` e `status`.
- `GET /:patientId/balance/details` (`routes/patient.js:395`) — retorna `PatientBalance`.

Hoje, nenhum consumidor de produção no frontend soma os dois. Qualquer tela nova que fizer isso deve tratar a interseção para evitar dupla contagem.

---

## 6. Reparo de dados

Sessões sem `paymentStatus` criadas entre 2026-04-29 e o deploy do PR-0 devem ser reparadas em PR separado:

- Sessões avulsas ou `missed` sem pacote → `paymentStatus: 'pending'`, `isPaid: false`.
- Sessões de pacote transferido confirmadas como quitadas → `paymentStatus: 'package_paid'`, `isPaid: true`.
- Sessões de pacote com dúvida → auditoria individual antes de aplicar qualquer valor.

O reparo deve ser:

- Idempotente.
- `dryRun` por padrão.
- Com evidência antes/depois.
- Fora do escopo: 240 sessões de 2025-07 a 2025-10 sem `paymentStatus` (dados anteriores ao plugin, provavelmente de convênio/caixa).
