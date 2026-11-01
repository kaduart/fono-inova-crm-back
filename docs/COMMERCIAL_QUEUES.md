# Filas comerciais (V2)

## O que é

São quatro filas que ajudam a secretária a vender e a reter pacientes. Elas aparecem no Dashboard do admin ("Precisa de você") e na Agenda. Foram aprovadas pelo Kadu em 30/10/2026.

| Fila | Endpoint | Onde aparece |
|---|---|---|
| Encaixe inteligente | `GET /api/v2/commercial/fit-candidates?specialty=` | Horário livre na Agenda (dia por profissional) e na Recorrência |
| Pacote acabando | `GET /api/v2/commercial/package-ending` (padrão `auto`; `?threshold=0..5` mantém limite fixo) | Dashboard, "Precisa de você" |
| Risco de evasão | `GET /api/v2/commercial/churn-risk` | Próximas Ações da secretária (card crítico) |
| Reativação | `GET /api/v2/commercial/reactivation?minDays=7` | Dashboard e Acompanhamento |
| Lead sem resposta | `GET /api/v2/commercial/leads-waiting?hours=2` | Topo do Dashboard, com cronômetro |
| Avaliou e não fechou | `GET /api/v2/commercial/evaluation-no-package?minDays=3&maxDays=30` | Dashboard, "Precisa de você" |
| Próximo dia útil sem confirmação | `GET /api/v2/commercial/unconfirmed-next-day` e `POST /api/v2/commercial/confirmation-reminders` | Dashboard, "Precisa de você" |
| Registro do contato | `POST /api/v2/commercial/contacts` | Botão "Marcar como contatado" das filas |

O acesso é só para `admin` e `secretary`.

## Por quê

- Um horário vago é receita perdida. Quem pode ocupar a vaga é quem já procura a especialidade: um lead aberto ou um paciente sem próxima sessão.
- Quando o pacote acaba sem renovação, o paciente costuma sumir.
- Um lead novo que espera mais de 2h esfria.

## Regras

- **Somente leitura em entidades canônicas.** As filas só leem Appointment, Patient, Package, Lead e Message. A única escrita vai para a coleção `commercialcontacts` (model `CommercialContact`), e nenhum outro fluxo depende dela.
- **Próxima sessão:** usa `scheduled`, `confirmed` e `pre_agendado`, igual à Retenção V2 (DOMAIN_INVARIANTS: `pre_agendado` entra em todo filtro ativo).
- **Sem próxima sessão:** paciente com sessão `completed` nos últimos 120 dias e nenhuma sessão futura. No encaixe, a regra vale dentro da especialidade do horário.
- **Pacote acabando:**
  - entram pacotes `active` que não são `convenio`/`liminar`, porque esses tipos são legado e não renovam;
  - as sessões restantes são calculadas como `totalSessions − sessionsDone`, já que `remainingSessions` é virtual (ADR-003) e nunca é gravado;
  - se o paciente já tem outro pacote ativo na mesma especialidade, vale o pacote com mais sessões, então quem já renovou sai da fila.
- **Lead esperando:**
  - entram leads abertos que chegaram nos últimos 3 dias;
  - a espera começa na última mensagem do WhatsApp do próprio lead (inbound);
  - se a clínica falou por último (Amanda ou humano), o lead não está esperando;
  - sem mensagens, vale a última interação; sem interação, vale `createdAt`;
  - "Respondido" marcado na fila (contato `lead_reply` depois do início da espera) tira o lead da fila, porque a equipe pode ter respondido por fora do ERP.
- **Área do lead:** `Lead.therapyArea` é texto livre, então `normalizeArea()` converte para a especialidade do Doctor (por exemplo, "fono" vira `fonoaudiologia` e "Terapia Ocupacional" vira `terapia_ocupacional`).
- **Contato registrado:**
  - um contato registrado nos últimos 7 dias manda o item para o fim da fila sem escondê-lo;
  - um duplo clique (mesmo alvo, tipo e usuário em até 5 min) não duplica o registro.
- **Mensagens:** o WhatsApp é aberto pelo front com um texto pronto, e o back não envia mensagem nenhuma. A Amanda não é acionada.

## Para mexer sem quebrar

- As regras puras ficam em `services/commercial/commercialRules.js`, com teste em `tests/unit/commercialRules.test.js`.
- Se mudar o critério de "próxima sessão", mude também em `routes/retention.v2.js`, para a Agenda e o Dashboard mostrarem os mesmos números.
- O front consome isso em `src/services/commercialService.ts`.


## Avaliou e não fechou / Próximo dia útil sem confirmação (31/10/2026)

As duas filas foram aprovadas pelo Kadu a partir do mock https://claude.ai/artifact/CxuQNs2oT4a6x6LNs5BqdD. As regras ficam em `services/commercial/evaluationConfirmationQueues.js`, com testes em `tests/unit/evaluationConfirmationQueues.test.js`.

- **Avaliou e não fechou:**
  - Entra a avaliação `completed` (`serviceType` `evaluation` ou `neuropsych_evaluation`, particular) feita de 3 a 30 dias atrás.
  - Sai quem tem um pacote `therapy` ativo, criado depois da avaliação ou na véspera dela (a data de criação vem do `_id`), quem tem sessão futura ativa e quem foi marcado como "Não vai fechar" (`kind: evaluation_lost`, com o motivo em `note`).
  - O contato registrado usa `kind: evaluation`.
  - O potencial mensal é o número de pessoas × R$ 720. Ele é calculado no back.
- **Próximo dia útil sem confirmação:**
  - O dia é o primeiro, entre os próximos 7, que tem sessão ativa (`pre_agendado`, `scheduled` ou `confirmed`).
  - A sessão é "não confirmada" quando o `operationalStatus` não é `confirmed` e o `attendanceConfirmation.status` também não é `confirmed`.
  - Estados: `not_sent`, `no_reply`, `change_requested`, `review_required` e `no_phone`.
- **Lembrete em lote:**
  - Só vai para quem está em `not_sent`, pela fila `whatsapp-send` com `purpose: attendance_confirmation`. A enquete "Confirmar presença" é a mesma da Agenda Externa.
  - Usa o `jobId` fixo `attconf-<appointmentId>`, então é no máximo 1 lembrete por sessão, mesmo com duplo clique.
  - Grava `attendanceConfirmation.queuedAt`.
  - Se a fila estiver pausada pelo kill switch, a resposta traz `queuePaused: true`.
  - A Amanda não é acionada.


## Pacote a 80% e Risco de evasão (01/11/2026)

Aprovados pelo Kadu no plano de Inteligência Operacional. Evoluem as filas acima em vez de criar uma coleção nova, para a secretária não ver o mesmo paciente em dois cards. Regras puras em `services/commercial/commercialRules.js`, testes em `tests/unit/renewalChurnRules.test.js`.

- **Pacote a 80%:**
  - `threshold=auto` (padrão quando o parâmetro não vem): entra quando faltam até `max(1, floor(totalSessions × 0,2))` sessões. Pacote de 12 entra em 10/12; pacote mensal de 4 entra em 3/4.
  - Cada item traz `stage`: `renovar` (amarelo, gerar a cobrança do próximo mês) ou `ultima` (laranja, falta 1 sessão ou já acabou). `ok` só aparece fora da fila.
  - Quem já renovou na mesma especialidade continua saindo da fila (vale o pacote com mais sessões sobrando).
  - O evento `SESSION_COMPLETED` do outbox já leva `packageId`. Quando o app Conecta tiver vínculo com o CRM, o push "seu ciclo está terminando" assina esse evento; nada muda no `completeSessionService.v2` agora.
- **Risco de evasão (churn):**
  - Entra paciente `status: 'active'` com sessão `completed` nos últimos 90 dias e nenhuma sessão futura (`FUTURE_STATUSES`) há 14 dias ou mais. Se o pacote ativo é quinzenal (`frequencyInterval: 'biweekly'`), são 21 dias.
  - Sai quem tem **falta justificada**: cancelamento com `cancelRequester: 'patient'` nos últimos 30 dias (a família avisou).
  - Sai quem tem **pausa vigente**: contato `kind: churn_pause` com `until` no futuro (máximo 90 dias). A pausa é registrada por `POST /contacts` com `{ kind: 'churn_pause', until }`, sem escrever no Patient.
  - Cada item traz `severity: 'critical'`, `title` ("Risco de evasão: Nome está sem agendamento há N dias") e `message`, o texto pronto do WhatsApp. O front abre o WhatsApp e registra `kind: churn`; o back não envia mensagem.
  - É calculado na leitura, sem cron. O índice `{ patient: 1, date: 1 }` de Appointment já cobre as consultas por paciente.
