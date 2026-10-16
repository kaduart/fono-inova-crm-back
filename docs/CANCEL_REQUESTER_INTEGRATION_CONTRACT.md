# Contrato — quem solicitou o cancelamento (integrações)

Atualizado em 2026-10-16 (revisado: prazo exato, pré-agendado, cancelamentos automáticos). Vale para **Agenda Externa** (repo `agenda`) e **Amanda** (WhatsApp).
Regra de ouro: **nunca inferir o solicitante** pelo token de serviço, pelo texto do motivo ou pelo
status "falta confirmada". Só o canal que *sabe* quem pediu deve informar.

## Campos (corpo do `PATCH /api/v2/appointments/:id/cancel`)

| Campo | Obrigatório? | Valores / formato |
|---|---|---|
| `reason` | sim (motivo livre) | texto |
| `cancelRequester` | **sim para usuários do CRM**; opcional para tokens de serviço (transição) | `patient` · `professional` · `clinic` |
| `cancelRequestedAt` | não | ISO-8601; quando o pedido chegou (não pode estar no futuro) |
| `notifyPatient` | não | `true` enfileira o aviso por WhatsApp **depois** de salvar; qualquer outro valor/ausente = não envia |

Erros: `400 MISSING_CANCEL_REQUESTER`, `400 INVALID_CANCEL_REQUESTER`, `400 INVALID_CANCEL_REQUESTED_AT`.

Resposta inclui `notification`: `{ status: not_requested | queued | already_queued | no_phone | failed, error? }`.
`queued` = **enfileirado**, não entregue. Reenvio sem cancelar de novo:
`POST /api/v2/appointments/:id/cancel/notify-patient` (idempotente por cancelamento).

## Caminhos conhecidos e situação atual

| Caminho | Quem chama | Envia `cancelRequester`? | O que acontece hoje |
|---|---|---|---|
| CRM (calendário, financeiro, liminar, convênio, pacotes) | usuários logados | **sim, obrigatório** | grava solicitante |
| `PATCH /v2/appointments/:id/cancel` — Agenda Externa (`agenda/src/api/v2/agendaV2Client.js::cancelAppointment`) | token `agenda-service` | **não** | cancela; fica "Não informado" com `cancelChannel='agenda_service'` |
| `POST /import-from-agenda/agenda-externa/cancel` (sync legado) | agenda externa | **não** | idem; aceita `cancelRequester`/`cancelRequestedAt` opcionais (validados) |
| Amanda (WhatsApp) | — | — | **não há caminho que cancele agendamento hoje** (o `wantsCancel` é só detecção de intenção; o único `canceled` no orquestrador é de *Followup*, outro domínio) |
| Telas antigas do CRM abertas durante o deploy | usuários | não | aceito até **30/11/2026** (`legacyGraceUntil` em `domain/appointment/cancelRequester.js`) como `cancelChannel='legacy_client'`; depois disso volta a 400 |

Todos os "Não informado" aparecem no relatório (aba *Sem identificação*), com o canal de origem.

## Quando a obrigatoriedade passa a valer (instante exato)

Fuso: America/Sao_Paulo (UTC-3). Constante: `LEGACY_GRACE_ENDS_AT_ISO = 2026-12-01T00:00:00-03:00`
em `domain/appointment/cancelRequester.js`.

- Até **30/11/2026 23:59:59.999** (o dia 30 inteiro) o backend ainda aceita cancelamento **de usuário do CRM** sem
  solicitante e marca `cancelChannel=legacy_client`.
- A partir de **01/12/2026 00:00:00** passa a responder **400 MISSING_CANCEL_REQUESTER**.
- Teste: `tests/unit/cancelRequesterGrace.test.js` (cobre 23:59:59.999 do dia 30 e 00:00:00 do dia 1º).

| Canal | Solicitante | Valia antes do prazo | Vale a partir de 01/12/2026 00:00 |
|---|---|---|---|
| CRM — usuário logado (calendário, financeiro, liminar, convênio, pacotes) | obrigatório | aceita ausência (telas antigas) → `legacy_client` | **obrigatório (400 sem ele)** |
| Agenda externa — `PATCH /v2/appointments/:id/cancel` (token `agenda-service`) | opcional no backend; **o modal novo da agenda sempre envia** | opcional → "Não informado" + `agenda_service` | **continua opcional no backend** (decisão pendente de endurecer; ver abaixo) |
| Agenda externa — sync legado `/import-from-agenda/agenda-externa/cancel` | opcional | opcional | continua opcional |
| Amanda (WhatsApp) | não existe caminho que cancele agendamento | — | — |

> Endurecer o canal `agenda-service`: remover `required: !req.user?.isService` em `routes/appointment.v2.js`
> **somente depois** de a agenda externa estar em produção com o modal novo. Não há data definida; não é automático.

## Pré-agendado

Descartar/cancelar um **pré-agendamento** é um cancelamento: na agenda externa exige **quem solicitou** + motivo, igual a
um agendamento normal (ícone da linha **e** troca de status para cancelado no modal de edição). No CRM o backend já exigia
o solicitante para qualquer cancelamento de usuário. "Confirmar" um pré-agendamento (virar agendamento) **não** é
cancelamento e não pergunta nada.

## Cancelamentos automáticos (`cancelSource`)

Contam como automáticos (separados dos manuais sem solicitante) os cancelamentos cujo `cancelSource` está em
`SYSTEM_CANCEL_SOURCES`. Passaram a ser marcados em 2026-10-16: `liminar_plan_update` (dia da semana removido do plano da
liminar), `unconfirmed_auto` (job das 18h) e `package_exhausted` (pacote esgotado). **Histórico antes disso não tem a marca
e continua como "Não informado"** — não é reclassificado nem inferido pelo texto do motivo.

## O que cada integração precisa fazer

### Agenda Externa
1. No `CancelReasonModal`, perguntar **"Quem solicitou?"** (3 opções, sem padrão) além do motivo.
2. Enviar `cancelRequester` (e `cancelRequestedAt` se a secretária informar) em `cancelAppointment(...)`. **Feito** (2026-10-16): modal novo, ícone na linha, pré-agendado incluído.
3. Não enviar `notifyPatient: true` sem checkbox visível ao usuário (hoje envia sempre `false`).
4. Depois que a agenda enviar o campo, o backend poderá passar a exigi-lo também para `agenda-service`
   (remover `required: !req.user?.isService` em `routes/appointment.v2.js`).

### Amanda
- Se um dia cancelar agendamento a pedido do paciente no WhatsApp, enviar `cancelRequester: 'patient'`
  **somente** quando a mensagem do paciente for o pedido explícito; usar `cancelRequestedAt` = hora da mensagem.
- Pedido de cancelamento vindo do profissional/clínica não deve ser deduzido pela conversa — encaminhar à secretária.

## Aviso por WhatsApp
- Texto montado no backend (`cancellationNotification.service.js`); **não inclui `cancelReason`** (campo livre, pode ser
  anotação interna). Telefone: `Patient.phone`; sem telefone válido → `no_phone`.
- Dedup: reivindicação atômica no Appointment + `jobId` determinístico (`cancel-notify-<id>-<canceledAt>`);
  reativar o agendamento limpa o estado do aviso.
