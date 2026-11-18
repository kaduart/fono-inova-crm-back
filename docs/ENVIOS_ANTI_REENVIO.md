# Proteção local contra reenvio de WhatsApp e e-mail

**Isto não é "exatamente uma vez".** O provedor externo (WhatsApp Web, VPS, Meta, Resend) não participa da nossa gravação. Se o processo cai, ou a chamada estoura o tempo, depois de o provedor aceitar e antes de gravarmos o resultado, não há como saber se a mensagem saiu. Nesses casos o envio fica `unknown` e **não é repetido automaticamente**.

## 1. Mecanismo (`infrastructure/delivery/deliveryGuard.js`)

A coleção `outbound_deliveries` tem um documento por chave de entrega (`_id`).

| Estado | Significado | Próxima execução com a mesma chave |
|---|---|---|
| `sending` com lease vivo (120 s) | Uma execução está chamando o provedor | `in_progress`, não envia |
| `sending` com lease vencido | Tentativa abandonada (queda ou reinício) | Vira `unknown`, não envia |
| `sent` | Provedor aceitou | `already_sent`, não envia |
| `failed` | Erro que **prova** que nada saiu | Nova tentativa (reserva condicional; só uma vence) |
| `unknown` | Resultado incerto | Não envia; precisa de decisão humana |

A reserva é um `insertOne` com `_id` único, feito antes de chamar o provedor. Duas execuções simultâneas nunca chamam o provedor ao mesmo tempo para a mesma chave.

**O que prova "não enviado"** (`isDefinitelyNotSent`):
- HTTP 4xx, exceto 408;
- ECONNREFUSED, ENOTFOUND, EAI_AGAIN;
- telefone inválido;
- WhatsApp Web desconectado sem tentativa de fallback na VPS.

Todo o resto conta como incerto: timeout, ECONNRESET, 5xx, falha do fallback na VPS e erro desconhecido.

**Privacidade:** o registro guarda só o hash do destino. Não guarda telefone, e-mail nem texto.

**Decisão humana:** `resolveUncertainDelivery(chave, { as: 'sent' | 'failed', by, note })` só altera envios `unknown` e grava quem decidiu na trilha `history`. Ainda não há rota de API para isso, o que é uma pendência para quando houver painel. Até lá, a consulta operacional é:

```
db.outbound_deliveries.find({status:'unknown'})
```

## 2. Onde foi aplicado

| Caminho | Chave | Antes | Agora |
|---|---|---|---|
| `whatsappSendWorker` (fila `whatsapp-notification`) | `wa:send:<idempotencyKey \| job.id>` | Consultava `Message` antes de enviar, mas a mensagem só é gravada depois. Dois jobs simultâneos, ou uma queda depois do envio, reenviavam | Reserva atômica |
| `followupOrchestratorWorker` | `followup:<followupId>:<tentativa>` | Uma queda entre o envio e `Followup.status='sent'` reenviava na reentrega | Envio já feito fecha o follow-up; incerto não reenvia |
| `notificationOrchestratorWorker` (WhatsApp e e-mail) | `notif:<canal>:<eventId \| idempotencyKey \| job.id>` | `eventExists` antes do envio; fallback de chave com `Date.now()` | Reserva atômica. `NOTIFICATION_SENT` só sai quando enviou agora |
| `leadRecoveryService` (cron de recuperação) | `recovery:<leadId>:stage<n>:<template\|text>` | Uma queda antes de avançar `recovery.stage` reenviava no próximo ciclo; dois ciclos simultâneos duplicavam | Cada parte sai uma vez; incerto não avança o estágio |
| `whatsapp-child` (fila `whatsapp-send`, WhatsApp Web: aniversário, resumo à família, confirmação de presença, mensal) | `wweb:send:<job.id>` (helper `workers/entrypoints/whatsappWebDelivery.js`) | Jobs com `attempts: 3`: timeout do Puppeteer depois de a mensagem sair fazia o BullMQ reenviar até 3 vezes | Retry só quando o erro prova que nada saiu (desconectado, número inválido, sem WhatsApp). Já enviado devolve o `messageId` original e refaz só as marcações idempotentes |
| `AmandaOrchestrator` (localização: pin + texto) | `amanda_location:<id da mensagem recebida>:<pin\|text>` | Reprocessar a mesma mensagem recebida (retry do job, reentrega do webhook) mandava a localização de novo | Uma vez por mensagem recebida; sem id de entrada, envia como antes |
| `amandaBookingService` (aviso ao dono de novo agendamento) | `booking_owner_notice:<appointmentId>` | Reprocessar o mesmo agendamento avisava o dono de novo | Uma vez por agendamento; sem id, envia como antes |

### Janela incerta (vale para todos os caminhos acima)

Entre o provedor aceitar a mensagem e gravarmos `sent` existe uma janela que nenhum código local fecha:

1. reserva gravada (`sending`);
2. chamada ao provedor;
3. **janela incerta:** o provedor aceitou, mas a resposta não chegou (timeout, queda do processo, reinício do container do worker, perda de conexão com o Mongo);
4. gravação de `sent`.

Se algo dá errado no passo 3, o registro fica `sending` (vira `unknown` quando o lease vence) ou `unknown`. **A proteção escolhe não reenviar:** o risco aceito é a mensagem não sair, nunca sair duas vezes. Quem resolve é um operador (`resolveUncertainDelivery`). No WhatsApp Web, o `getNumberId` também conta como incerto quando falha por rede, por conservadorismo.

Privacidade no WhatsApp Web: o `messageId` (`true_<telefone>@c.us_<id>`) contém o número. Ele fica gravado em `providerMessageId` porque a enquete de confirmação casa o voto por esse id. Fora dele o registro não tem telefone.

## 3. O que já existia e foi mantido

O e-mail de convênio (`EmailDeliveryProvider`, fila `communication-email`) tem três proteções:
- log `PENDING` por `jobId`, que bloqueia reenvio com resultado incerto;
- envio ao Resend com `idempotencyKey = jobId`. O Resend descarta repetições da mesma chave por 24 h, e essa é a única proteção externa real deste inventário;
- resta uma brecha: a criação do log não é atômica. Dois processos com o mesmo `jobId` ao mesmo tempo, o que só acontece com job travado, poderiam passar. O Resend cobre.

Nota: no `notificationOrchestratorWorker`, o e-mail é um **mock**, que só registra em log. Não há envio real de e-mail por esse caminho hoje.

## 4. Fora do escopo (pendências)

- `controllers/whatsappController.js`: envio manual pela tela. É uma pessoa clicando; duplo clique e reenvio HTTP pedem `Idempotency-Key` no front.
- Respostas de texto livre da Amanda dentro da conversa (fluxo do `whatsappService`): ainda sem chave estável por resposta. A localização e o aviso ao dono já foram cobertos (seção 2).
- `middleware/whatsappGuard.js` (alerta ao admin) e `routes/whatsappVPS.js` (rota administrativa de teste): internos, repetição tolerada.
- `controllers/authController.js` (redefinição de senha): cada pedido gera um link novo; repetir é intenção do usuário.
- Índice `status_createdAt`: criado em produção pelo Kadu em 18/11/2026 (script `criar-indices-protecoes.mjs`, só índices).

A lista completa e classificada está em `tests/delivery/sendPathsInventory.nodetest.mjs`. Um arquivo novo que importe uma função de envio sem classificação faz o teste falhar.

## 5. Testes

| Arquivo | Casos | O que cobre |
|---|---|---|
| `tests/delivery/deliveryGuard.mongo.nodetest.mjs` (`npm run test:envios-anti-reenvio`) | 9 | Envio normal, 10 concorrentes, erro que prova não envio com retry, retries concorrentes, timeout/5xx/desconhecido, queda com lease vivo e vencido, sucesso depois do lease, resolução manual auditada, classificação. Provedor simulado; nenhum envio real |
| `tests/delivery/whatsappWebDelivery.mongo.nodetest.mjs` (`npm run test:envios-whatsapp-web`) | 6 | Fila `whatsapp-send`: reprocessar não reenvia e devolve o messageId; timeout fica incerto sem retry; desconectado/sem WhatsApp lança e o retry envia; 5 workers simultâneos = 1 envio; jobs diferentes são envios distintos |
| `tests/delivery/sendPathsInventory.nodetest.mjs` (`npm run test:envios-inventario`) | 6 | Inventário estático: todo arquivo que importa função de envio está classificado; os protegidos usam o guarda |
| `tests/unit/whatsappSendWorker.deliveryGuard.test.js` (vitest) | 6 | Fiação do worker: chave, `job.id` como fallback, os três resultados sem envio, erro que sobe para retry |
