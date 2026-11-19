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
| Ponte do conector externo (`workers/whatsappConnectorBridge.js`, fila `whatsapp-send` com `WHATSAPP_CONNECTOR_MODE=external`) | `wweb:send:<job.id>` (a mesma do child; vai também como `requestId` ao conector, que deduplica de novo) | Mesmo risco do child, agora com rede entre CRM e conector | Igual ao child. Timeout ou resposta perdida: consulta `GET /v1/messages/:requestId`; sem resposta, fica incerto e não reenvia. Ver `docs/WHATSAPP_CONECTOR_EXTERNO.md` |
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

O e-mail de convênio (`EmailDeliveryProvider`, fila `communication-email`) tem agora quatro proteções:
- log `PENDING` por `jobId`, que bloqueia reenvio com resultado incerto;
- **reserva atômica no guarda** (`outbound_deliveries`, chave `email:convenio:<jobId>`) antes de chamar o provedor. Fecha a brecha antiga: a leitura do log no início não era atômica, e dois processos com o mesmo `jobId` ao mesmo tempo enviavam os dois. Teste: contra o código anterior, 3 execuções simultâneas chamavam o provedor 3 vezes e deixavam 3 linhas; agora 1 chamada e 1 linha. A execução que não reservou apaga a linha `PENDING` que tinha criado;
- timeout/queda de conexão depois de chamar o provedor fica `unknown` e o retry do BullMQ **não** reenvia (antes reenviava: 2 chamadas no teste);
- envio ao Resend com `idempotencyKey = jobId`. O Resend descarta repetições da mesma chave por 24 h, e essa é a única proteção externa real deste inventário.

Erro de configuração (`RESEND_API_KEY não configurada` e afins) passou a contar como "prova que nada saiu" (`failed`, aceita nova tentativa), porque o cliente do provedor nem chega a ser criado.

### Envio manual pela tela (WhatsApp)

- `POST /whatsapp/send-text` e o envio manual pelo lead aceitam `Idempotency-Key` (8 a 128 caracteres). Com a chave, o envio passa pelo guarda com a chave `wa:manual:<usuário>:<chave>:<hash do número>`; o número não aparece na chave.
- Respostas: chave já enviada → 200 `duplicated: true` com o `messageId` original, nada reenviado; outra requisição com a mesma chave em voo → 409 `DELIVERY_IN_PROGRESS` (`retryable: true`); resultado desconhecido (timeout, queda) → 409 `DELIVERY_UNCERTAIN` (`retryable: false`), com o texto "confira a conversa no WhatsApp antes de mandar de novo".
- Front (`messageIdempotency`): a chave nasce na primeira tentativa de mandar aquele texto para aquele número e é reaproveitada no clique duplo e na retentativa depois de erro de rede. Depois de 2xx, o mesmo texto de novo é outra mensagem. Depois de `DELIVERY_UNCERTAIN` a chave é descartada: reenviar é decisão da pessoa, depois de conferir.
- Sem a chave (cliente antigo), o comportamento é o anterior.
- Template e mídia manuais (`send-template`, `send-media`) seguem a mesma regra desde 19/11 (CRM #89). Chaves internas: `wa:manual:<usuário>:tpl:<chave>:<hash>` e `wa:manual:<usuário>:media:<chave>:<sha256 do arquivo, 16>:<hash>`. Na mídia, a mesma chave com outro arquivo é outro envio. Front: `wa-template:<número>` (template + parâmetros) e `wa-media:<número>` (nome, tamanho, data do arquivo e legenda).
- Teste pelo controller real (`tests/delivery/manualTemplateMedia.mongo.nodetest.mjs`, provedor simulado): 6/6 no código novo, 0/6 no anterior (repetição, 5 cliques simultâneos, timeout incerto sem reenvio, sem chave = antigo, chave inválida = 400, outro arquivo = outro envio, desconectado libera o reenvio).

### Amanda ao reativar ("Ativar Amanda")

A chave da resposta enfileirada era `amanda-resume:<lead>:<Date.now()>`, diferente a cada clique; dois cliques na mesma pendência podiam gerar duas respostas. Agora é `amanda-resume:<lead>:<id da mensagem recebida que está sendo respondida>`, que cai no guarda `wa:send:` do `WhatsappSendWorker`: uma resposta por mensagem pendente.

### Correção da matriz

A resposta automática da Amanda pela fila (`whatsappAutoReplyWorker`) já usava `amanda-reply:<lead>:<wamid>` e passava pelo guarda `wa:send:` do `WhatsappSendWorker`. A matriz anterior listava esse caminho como aberto; não estava.

Nota: no `notificationOrchestratorWorker`, o e-mail é um **mock**, que só registra em log. Não há envio real de e-mail por esse caminho hoje.

## 4. Fora do escopo (pendências)

**Classificação do item 4: PARCIAL.** Os caminhos abaixo continuam sem proteção completa:

- **Manual sem chave.** Texto, template e mídia só ficam protegidos quando o cliente manda `Idempotency-Key`. O back aceita requisição sem chave (compatibilidade com front antigo em cache, scripts e integrações), e essas requisições enviam como antes. Impedimento concreto: tornar a chave obrigatória quebra qualquer cliente que ainda não a envia. Isso só pode virar regra depois que o front novo estiver em produção, com uma janela de observação (log de requisições sem chave). É decisão de ativação, não de código.
- **Janela incerta do provedor.** Meta Cloud API, WhatsApp Web e VPS não deduplicam. Se a resposta se perde, o envio fica `unknown` e nada é reenviado sozinho; alguém precisa conferir no aparelho. Impedimento concreto: só o provedor poderia fechar essa janela, e nenhum dos três oferece chave de idempotência (seção 6).
- **Sem tela para resolver `unknown`.** A função `resolveUncertainDelivery` existe e é auditada, mas não há rota nem tela que a chame.
- **Texto livre da Amanda fora da fila.** Na rota ativa não existe: `runOrchestrator` → `WhatsAppOrchestrator` (FSM) / agente Amanda só devolvem texto, e quem envia é o `whatsappAutoReplyWorker` pela fila (`amanda-reply:<lead>:<wamid>`, guarda `wa:send:`). Os envios diretos que restam estão no `orchestrators/AmandaOrchestrator.js` legado: localização sem id de entrada (cai em envio sem chave) e `tryManualResponse`, cuja chamada está comentada. Nenhum módulo de produção importa esse arquivo; só os scripts de `tests-amanda-ouro`. Impedimento concreto para pôr chave ali: sem id da mensagem recebida não existe chave estável, e inventar uma chave (relógio, texto) bloquearia respostas legítimas iguais. O que foi feito: dois testes no inventário. Um falha se algum código de produção voltar a importar o `AmandaOrchestrator`. O outro falha se a rota ativa passar a chamar o provedor direto.
- **Fora da proteção por decisão:** `middleware/whatsappGuard.js` (alerta ao admin), `routes/whatsappVPS.js` (teste administrativo) e `controllers/authController.js` (cada pedido de senha gera link novo).
- Índice `status_createdAt`: criado em produção pelo Kadu em 18/11/2026 (script `criar-indices-protecoes.mjs`, só índices).

A lista completa e classificada está em `tests/delivery/sendPathsInventory.nodetest.mjs`. Um arquivo novo que importe uma função de envio sem classificação faz o teste falhar.

## 5. Testes

| Arquivo | Casos | O que cobre |
|---|---|---|
| `tests/delivery/deliveryGuard.mongo.nodetest.mjs` (`npm run test:envios-anti-reenvio`) | 9 | Envio normal, 10 concorrentes, erro que prova não envio com retry, retries concorrentes, timeout/5xx/desconhecido, queda com lease vivo e vencido, sucesso depois do lease, resolução manual auditada, classificação. Provedor simulado; nenhum envio real |
| `tests/delivery/whatsappWebDelivery.mongo.nodetest.mjs` (`npm run test:envios-whatsapp-web`) | 6 | Fila `whatsapp-send`: reprocessar não reenvia e devolve o messageId; timeout fica incerto sem retry; desconectado/sem WhatsApp lança e o retry envia; 5 workers simultâneos = 1 envio; jobs diferentes são envios distintos |
| `tests/delivery/manualEmail.mongo.nodetest.mjs` (`npm run test:envios-manual-email`) | 9 | Envio manual: repetição devolve 200 duplicado, 10 concorrentes = 1 envio, timeout incerto sem reenvio, reinício com reserva abandonada vira incerto, desconectado libera retry, chaves/números diferentes e sem chave enviam. E-mail convênio pelo `executeDelivery` real com Resend simulado: 3 execuções simultâneas = 1 envio e 1 linha; timeout incerto sem reenvio |
| `tests/delivery/manualTemplateMedia.mongo.nodetest.mjs` (`npm run test:envios-template-midia`) | 6 | Template e mídia manuais pelo controller real com provedor simulado (módulo mockado). 0/6 no código anterior |
| Front `src/services/__tests__/idempotency.whatsapp.test.ts` (vitest) | 6 | Mesma chave na retentativa, clique duplo sai uma vez, nova chave depois de enviada, 409 em andamento mantém e incerto descarta; mídia (mesmo arquivo mesma chave, outro arquivo outra chave) e template (clique duplo) |
| `tests/delivery/sendPathsInventory.nodetest.mjs` (`npm run test:envios-inventario`) | 11 | Inventário estático: todo arquivo que importa função de envio está classificado; os protegidos usam o guarda; 4 envios manuais pelo guarda; `AmandaOrchestrator` sem importador de produção; rota ativa da Amanda sem envio direto |
| `tests/unit/whatsappSendWorker.deliveryGuard.test.js` (vitest) | 6 | Fiação do worker: chave, `job.id` como fallback, os três resultados sem envio, erro que sobe para retry |

## 6. Limites que dependem do provedor (não prometemos "exatamente uma vez")

| Provedor | O que ele garante | O que sobra para nós |
|---|---|---|
| WhatsApp Web (chip, `whatsapp-web.js`) | Nada de idempotência: cada chamada é uma mensagem nova | Janela incerta: se cair depois do `sendMessage` e antes de gravar, fica `unknown` e alguém confere no aparelho |
| VPS (fallback) | Nada de idempotência conhecido | Igual ao WhatsApp Web |
| Meta Cloud API (template, mídia) | Não deduplica envios repetidos | Manual com chave não repete por nossa causa; a janela incerta continua |
| Resend (e-mail convênio) | Descarta a mesma `idempotencyKey` por 24 h | Depois de 24 h, só o guarda local; resultado incerto não reenvia |

Em todos: nossa proteção impede **repetição causada por nós** (retry, reentrega, dois workers, duplo clique, reinício). Não consegue saber o que o provedor fez quando a resposta se perde; nesse caso para e pede conferência humana em vez de arriscar mandar duas vezes.
