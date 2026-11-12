# Retomar contato: avaliou e não deu continuidade

## O que é

Envio em massa pelo WhatsApp da clínica para quem fez avaliação e sumiu: depois da avaliação não teve
nenhuma sessão (realizada ou marcada) nem pacote. Fica no painel "Avaliou e não fechou" do Dashboard,
botão "Retomar contato com quem sumiu". Pedido do Kadu em 12/11/2026.

`POST /api/v2/commercial/evaluation-reengage { period, atendente?, excludeIds?, confirm? }` (admin e secretária).
Regras em `services/commercial/evaluationReengagement.js`; testes em `tests/unit/evaluationReengagement*.test.js`.

## Por quê

A fila "Avaliou e não fechou" (docs/COMMERCIAL_QUEUES.md) cobre só 3 a 30 dias e é contato manual, um a um.
Quem avaliou há meses e não voltou não aparecia em lugar nenhum.

## Quem entra

- A avaliação MAIS RECENTE do paciente, `operationalStatus` `completed` ou `paid`, qualquer forma de pagamento
  (inclusive convênio). Avaliação = `serviceType` `evaluation`, `neuropsych_evaluation` ou `tongue_tie_test`,
  OU o primeiro atendimento realizado do paciente (desde jul/2026 a agenda lança a avaliação como sessão avulsa
  ou consulta). Regra em `findEvaluationLike` (services/commercial/evaluationConfirmationQueues.js).
- Período (`period`): `all` = todo o histórico (primeiro envio; só deixa de fora avaliação dos últimos 3 dias),
  `15`, `30` ou `60` = avaliou há mais de N dias.
- Sai quem, DEPOIS da avaliação, tem agendamento `completed`, `paid`, `scheduled`, `confirmed`, `pre_agendado`,
  `pending` ou `processing_*` (cancelado, falta e suspenso não contam: quem só desmarcou também sumiu).
- Sai quem tem pacote ativo, ou pacote (não cancelado) criado depois da avaliação ou na véspera.
- Sai quem tem sessão futura ativa (`FUTURE_STATUSES`, inclui `pre_agendado`).

## Fica de fora (a prévia mostra o motivo)

- `sem_telefone`: sem celular válido no cadastro.
- `inativo`: paciente inativado pela equipe (`Patient.status = inactive`).
- `nao_vai_fechar`: marcado como "Não vai fechar" na fila (`CommercialContact kind: evaluation_lost`).
- `conversa_recente`: mensagem trocada com o telefone nos últimos `EVALUATION_REENGAGE_RECENT_DAYS`
  (padrão 30) dias, pela coleção `Message` (ERP, Amanda, lembretes) ou pela trava do worker.
- Já recebeu por esta avaliação (`EvaluationReengagement.queuedAt`). Nunca repete para a mesma avaliação.

## Envio (mesmo motor dos convênios)

- 1 mensagem por telefone: irmãos com o mesmo celular recebem uma só, com os dois nomes.
- Fila `whatsapp-send`, `purpose: evaluation_reengage`, `jobId` fixo por avaliação, 3 tentativas com backoff.
- `scheduleSlots`/`busySlots` de `services/convenioWaitlistOffer.js`: 1 a cada ~90s, só dia útil 08:00–18:45,
  teto `CONVENIO_OFFER_DAILY_CAP` (40) por dia SOMANDO convênios e este envio (é o mesmo chip).
- Idempotente: `EvaluationReengagement` (coleção `evaluation_reengagements`, índice único por avaliação)
  recebe `queuedAt` ANTES de enfileirar; dois cliques não mandam duas vezes.
- Trava final no worker (`workers/entrypoints/whatsapp-child.js`): `getChatActivity(phone)` logo antes de enviar;
  se a clínica falou com a pessoa dentro da janela, não envia e grava `skippedAt`/`skipReason`.
- Worker grava `sentAt`/`messageId` quando sai; falha definitiva grava `error`.

## Escritas

Só `evaluation_reengagements`. Appointment, Patient, Package, Message e CommercialContact são só leitura.

## Desligar

Não há cron: nada sai sem o clique "Enviar" na tela. Para parar o que já está agendado, pausar a fila
`whatsapp-send` (kill switch) ou remover os jobs `evaluation-reengage-*`.
