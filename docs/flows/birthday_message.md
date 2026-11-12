# Parabéns de aniversário

**O que é:** parabéns pelo WhatsApp da clínica para pacientes ativos no dia do aniversário.

**Como funciona**
- Automático: `crons/birthdayMessage.cron.js` (10h) e o botão "Enviar parabéns" do Dashboard usam `sendBirthdayMessage` (`services/birthday/birthdayMessageService.js`). Só no dia, 1 vez por ano.
- Trava: `Patient.birthdayMessageSentYear` gravado de forma atômica ANTES de enfileirar (+ jobId `birthday-<id>-<ano>`). Cron e botão nunca duplicam.
- `birthdayMessageSentVia`: `auto` (enfileirado pelo sistema) ou `manual` (a equipe deu parabéns por fora).
- "Passou sem parabéns" (front `BirthdayList.isLateBirthday`): aniversário nos últimos 7 dias sem `birthdayMessageSent` no ano.
- "Já dei parabéns": `POST /api/patients/:id/birthday-message/mark` (admin/secretária) → `markBirthdayHandled`. Não envia nada; grava o ano com via `manual`. Só do dia até 7 dias depois; idempotente. O front chama ao abrir o link do WhatsApp de um atrasado, no botão "Já dei" e no "Marcar os N como parabenizados".

**Requisitos**
- Sem data fixa no código: tudo é por ano (`birthdayMessageSentYear`), vale para todo ano.
- Nunca mandar duas vezes no mesmo ano.
