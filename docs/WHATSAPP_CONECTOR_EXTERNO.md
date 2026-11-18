# Conector WhatsApp externo (whatsapp-web.js fora do crm-worker)

18/11/2026. Decisão do Kadu: manter whatsapp-web.js e tirar o Chrome do crm-worker. Não migrar para Meta Cloud API nem Baileys.

## 1. Por quê

O Chrome do whatsapp-web.js ocupa ~1,8–1,9 GB dos 2 GB do crm-worker (renderer ~1,1 GB, browser ~0,4 GB). Em repouso o cgroup fica em ~1,4–1,5 GB e os picos causam OOM, derrubando junto filas, crons e o envio de mensagens.

A separação **transfere** esse consumo para outro host; ela não o elimina.

## 2. Verificação da VPS existente (antes de implementar)

| Item | Resultado |
|---|---|
| `services/whatsappVPSService.js` | Só cliente: `POST {VPS_URL}/send` e `GET /health`. Usado como fallback **só de texto** em `whatsappService`, mais a rota `/api/whatsapp-vps`. |
| `VPS_WHATSAPP_URL` / `VPS_WHATSAPP_TOKEN` | Ausentes nos dois serviços do Render e vazias no `.env` local. |
| Código do servidor da VPS | Não existe em nenhum repositório kaduart. |
| Conclusão | **VPS inativa.** Não é reaproveitável: não há servidor, nem host comprovado, nem recursos além de texto. |

Hospedagem sem custo no Render (consultado em 18/11):

| Serviço | Plano | Serve para o conector? |
|---|---|---|
| crm-worker | standard 2 GB | É o que queremos aliviar |
| fono-inova-crm-back | starter | Não (pouca RAM, é a API) |
| recupera-api, conecta-api | free 512 MB | Não (Chrome não cabe) |
| fono-inova-crm-api | standard, **suspenso** | Reativar custa dinheiro |

**Bloqueio de hospedagem:** não existe capacidade comprovada a custo adicional zero. A implementação está completa e testada localmente; falta decidir onde o conector roda (seção 8).

## 3. Arquitetura e contrato

```
 crm-worker (sem Chrome)                       conector (Chrome + sessão)
 ├─ fila whatsapp-send ──HTTP assinado──────▶ POST /v1/messages (idempotente por requestId)
 ├─ fila whatsapp-scan ──HTTP assinado──────▶ /v1/chats/*, /v1/scans/deep-batch
 ├─ ponte: status a cada 5s ────────────────▶ GET /v1/status  → WhatsAppWebState (QR, ready)
 └─ worker de eventos ◀── fila BullMQ ◀── API: POST /api/whatsapp-connector/events ◀── outbox em disco
```

- **CRM** mantém todas as regras de negócio: origem do lead (ctwa), confirmação de presença, interesse em convênio, votos de enquete, atividade de conversa. Ficam em `services/whatsappInboundProcessor.js`, que é o mesmo código usado no modo local.
- **Conector** (`whatsapp-connector/index.js`) mantém só a sessão e o navegador. Não tem MongoDB nem Redis; o estado dele fica em disco (`WA_CONNECTOR_DATA_DIR`).

### 3.1 Autenticação (os dois sentidos)

- Header `x-wa-signature: t=<unix>,v1=<hex>`.
- `v1 = HMAC-SHA256(secret, "${t}.${METHOD}.${path}.${sha256(body)}")`.
- Janela de ±300 s. A troca de chave sem parada funciona com lista separada por vírgula: o primeiro valor assina e todos verificam.
- Só `GET /v1/health` é aberto.

### 3.2 Endpoints do conector

| Rota | Uso |
|---|---|
| `GET /v1/health` | vivo (aberto) |
| `GET /v1/status` | `{status, ready, authenticated, qrCode, lastDisconnectReason}` |
| `POST /v1/messages` | envio. Corpo: `{requestId, phone, text, kind, appointmentId?, poll?}` |
| `GET /v1/messages/:requestId` | resultado de um envio (resolve o "incerto") |
| `POST /v1/chats/activity`, `/v1/chats/activity-bulk` | data da última conversa |
| `POST /v1/scans/deep-batch` | lote da varredura profunda de convênio |
| `POST /v1/contacts/resolve-lids` | @lid → telefone |
| `POST /v1/polls/votes` | votos das enquetes de confirmação |
| `POST /v1/session/reconnect`, `/v1/session/clear` | controle da sessão |

### 3.3 Envio: deduplicação, timeout e resultado incerto

- O `requestId` é `whatsapp-send:<id do job>`. O conector grava cada requestId em `sends.json` com estado `in_progress → sent | failed | unknown` (TTL de 7 dias).
- Se o mesmo requestId chegar com o mesmo conteúdo, o conector devolve o resultado gravado e **não envia de novo**. Com conteúdo diferente, responde 409 `REQUEST_ID_REUSED`.
- Os envios são serializados, com intervalo mínimo `WA_CONNECTOR_SEND_MIN_INTERVAL_MS`.
- Respostas:
  - **sent**: devolve `messageId`.
  - **NOT_CONNECTED** (503): a mensagem não saiu. O requestId é liberado e o BullMQ tenta de novo depois.
  - **INVALID_NUMBER / NO_WHATSAPP** (422): falha definitiva, gravada como `failed`.
  - Qualquer outro erro, ou o tempo `WA_CONNECTOR_SEND_TIMEOUT_MS` estourado: **`unknown`**. Se o envio terminar depois do timeout, o estado vira `sent`.
- Do lado do CRM (`workers/whatsappConnectorBridge.js`, `services/whatsappConnector/client.js`):
  - Conector fora do ar (ECONNREFUSED etc.): "não saiu", tenta de novo.
  - Timeout ou resposta perdida: consulta `GET /v1/messages/:id` até 3 vezes. Um 404 significa "não recebido" e permite tentar de novo. Se continuar sem resposta, o resultado é **incerto**.
  - Incerto: o `deliveryGuard` (`outbound_deliveries`, chave `whatsapp-send:<job>`) registra `unknown`. O job **não** é marcado como enviado e **não** é reenviado. A resolução é humana, pelo fluxo existente `resolveUncertainDelivery`. Princípio: nunca mandar a mesma mensagem duas vezes para o paciente.
- Se o conector reiniciar no meio de um envio, o que estava `in_progress` vira `unknown` ao subir de novo, pela mesma regra.

### 3.4 Eventos (conector → CRM)

Formato: `{v, eventId, type, connectorId, occurredAt, data}`.

| type | data | eventId (estável) |
|---|---|---|
| `message.inbound` | `waMessageId, chatId, phone (null se @lid não resolvido), timestamp, body, notifyName, source ('live'\|'catchup'), ctwa?` | `in:<waMessageId>` |
| `message.outbound` | `waMessageId, phone, timestamp` | `out:<waMessageId>` |
| `poll.vote` | `voterPhone, pollMessageId, optionName, respondedAtMs` | `vote:<hash>` |

- **Outbox no conector** (`outbox.json`):
  - Entrega em lotes de 50, com backoff de 1 s a 5 min.
  - Um 4xx vai para `outbox-dead.jsonl`.
  - Limite de 20 mil eventos.
  - Sobrevive a reinício e ao CRM fora do ar.
- **Recepção no CRM**: a API verifica a assinatura e enfileira em `whatsapp-connector-events` com `jobId = wa-evt-<sha256(eventId)>`. Um evento repetido cai no mesmo job, então a deduplicação é garantida. Se o Redis cair, responde 503 e o conector tenta de novo.
- Um tipo desconhecido é ignorado, o que permite versões diferentes conviverem.

## 4. Recursos preservados e incompatibilidades

Preservados no modo externo:
- Envio das filas: texto e enquete de confirmação de presença, com o mesmo `processWhatsappSendJob` do modo local.
- Origem do anúncio (ctwa) ao vivo e no catch-up.
- Confirmação por texto.
- Interesse em convênio.
- Votos de enquete.
- Data da conversa da clínica.
- Varredura profunda e de atividade.
- Reparo de @lid.
- QR e status no painel, via `WhatsAppWebState`.
- Botão de reconectar.

Incompatibilidades e diferenças (documentadas, nenhuma nova regressão):
1. **Busca rápida de convênio (`scanConvenioInterest`)** continua desativada, como já estava. A varredura profunda funciona.
2. **`sendTextMessage` chamado fora do processo com Chrome** (pela API) já falha hoje com "não está conectado" e continua igual. O caminho suportado é a fila `whatsapp-send`.
3. **Fallback da VPS** (`whatsappVPSService`) segue como está (inativo). Não faz parte deste conector.
4. **Painel:** quando o conector não responde por 3 ciclos, o status vira `connector_unreachable`. O front mostra esse status como "desconectado" genérico. O ajuste visual fica para depois, se o Kadu quiser.
5. **Mídia pesada** (thumbnail, imagem do anúncio) não trafega nos eventos. O CRM nunca usou esses campos.

## 5. Garantia de "sem Chrome no CRM"

- Com `WHATSAPP_CONNECTOR_MODE=external`, e sem `WA_ENGINE_ROLE=connector`, `localChromeForbidden()` vale `true`:
  - `initWhatsAppClient` retorna sem criar Client.
  - `createClient` lança erro.
  - Reconexão, softReconnect, recuperação e retry passam todos por esses dois pontos.
- O `whatsapp-only.js` não cria o processo filho com Chrome.
- Testes (`tests/unit/whatsappConnector.noChrome.test.js`):
  - Boot, reconexão e soft reconnect não constroem nenhum `Client`.
  - O grafo de imports da ponte não alcança `whatsapp-web.js`, `puppeteer` nem `whatsappWebJsService`.

## 6. Variáveis de ambiente

CRM: crm-worker, e a API só onde indicado.

| Variável | Onde | Valor |
|---|---|---|
| `WHATSAPP_CONNECTOR_MODE` | crm-worker | `external` liga o modo externo; ausente mantém o modo atual (local) |
| `WA_CONNECTOR_URL` | crm-worker | URL base do conector (https) |
| `WA_CONNECTOR_SECRET` | crm-worker **e API** | segredo HMAC (≥32 chars), o mesmo do conector |
| `WA_CONNECTOR_TIMEOUT_MS` | crm-worker | leituras, padrão 15000 |
| `WA_CONNECTOR_SEND_TIMEOUT_MS` | não definir | padrão 100000 no CRM e 90000 no conector; o do CRM precisa ser maior, então se mudar, mude os dois mantendo essa folga |

Conector:

| Variável | Valor |
|---|---|
| `WA_CONNECTOR_SECRET` | o mesmo do CRM |
| `CRM_EVENTS_URL` | URL da API terminando em `/api/whatsapp-connector/events` |
| `WA_CONNECTOR_DATA_DIR` | disco persistente, padrão `/var/data/wa-connector` |
| `WHATSAPP_AUTH_PATH` | sessão do LocalAuth, padrão `/var/data/wwebjs_auth` |
| `WA_CONNECTOR_ID` | nome do conector nos eventos |
| `PORT` | padrão 8787 |
| `WA_CONNECTOR_SEND_MIN_INTERVAL_MS` | intervalo entre envios, padrão 1000 |

Comando: `node whatsapp-connector/index.js`. Usa o mesmo repositório e o mesmo `npm ci`, e precisa do Chrome fixado em `config/chromeVersion.js`.

## 7. Memória e capacidade

Medido em 18/11 na nuvem, importando exatamente o que o processo pai do `whatsapp-only.js` importa, mais a ponte:

| Processo | RSS |
|---|---|
| crm-worker pai (imports, sem filas rodando) | **177–184 MB**. Bate com o log de produção (175–185 MB). |
| + ponte do conector | +0 MB no import; estimativa de +20–60 MB com filas ativas |
| **crm-worker no modo externo (estimado)** | **~200–250 MB** (hoje: 1,4–1,5 GB em repouso, com picos de OOM) |
| conector, só o Node (sem Chrome) | 96 MB |
| conector + Chrome (dados de produção: ~1,8–1,9 GB) | **~2,0 GB em repouso** |

**Host do conector:** recomendado de **2,5 a 3 GB de RAM**, 1 vCPU, disco persistente de ≥1 GB (sessão mais `sends.json`/outbox) e HTTPS de entrada.

Com o worker em ~250 MB, ele passaria a caber num plano menor do Render. Essa decisão é do Kadu e não foi aplicada.

## 8. Procedimento de troca (para validação do Kadu, nada foi feito)

Pré-requisito: um host para o conector, que hoje está **bloqueado** (seção 2).

1. **Ensaio sem sessão real:**
   - Rodar `node whatsapp-connector/simulator.js` (WhatsApp falso) com o crm-worker do **espelho** em `WHATSAPP_CONNECTOR_MODE=external`.
   - Conferir:
     - status no painel;
     - um envio da fila;
     - um `emitInbound` chegando como evento e virando origem/confirmação.
2. **Merge do PR e deploy com a variável desligada.** Sem `WHATSAPP_CONNECTOR_MODE`, nada muda: o modo local continua idêntico.
3. **Subir o conector no host novo, ainda sem sessão:**
   - Configurar as envs da seção 6.
   - Conferir que `GET /v1/health` responde.
   - Colocar `WA_CONNECTOR_SECRET` na API e no crm-worker.
4. **Janela de troca (fora do horário de atendimento):**
   1. No crm-worker, definir `WHATSAPP_CONNECTOR_MODE=external` e `WA_CONNECTOR_URL`, e reiniciar. O Chrome local **para de existir** aqui.
   2. Levar a sessão. Opção A: copiar `/var/data/wwebjs_auth` do disco do crm-worker para o `WHATSAPP_AUTH_PATH` do conector. Opção B: escanear o QR de novo pelo painel.
   3. Iniciar o conector e esperar `ready: true` no painel.
   4. Testar: enviar uma mensagem de teste para o número da clínica e responder de outro celular. A origem e a confirmação devem aparecer.
5. **Monitorar por 24 h:**
   - memória do crm-worker;
   - `outbox-dead.jsonl` vazio;
   - nenhum `unknown` em `outbound_deliveries`;
   - log `📣 ctwa` nas conversas de anúncio.

**Nunca rodar as duas pontas na mesma sessão ao mesmo tempo.** O `takeoverOnConflict` faria uma derrubar a outra. Por isso o passo 4.1 vem antes do 4.3.

## 9. Reversão

1. Parar o conector.
2. No crm-worker, **remover** `WHATSAPP_CONNECTOR_MODE` e reiniciar. O processo filho com Chrome volta exatamente como hoje.
3. Sessão:
   - se ela ficou no disco do worker (opção A copia, não move), ele reconecta sozinho;
   - se não ficou, escanear o QR de novo.
4. Os eventos que ficaram no outbox do conector são descartáveis. O catch-up do modo local relê as conversas recentes, e a deduplicação por eventId e jobId evita duplicação se algum chegar depois.
5. Os envios incertos (`unknown`) continuam no `outbound_deliveries`, para resolução humana como hoje.

Não há migração de banco: nenhuma collection ou campo novo, só a fila `whatsapp-connector-events` no Redis. A reversão é só de variável de ambiente.

## 10. Testes

- `tests/unit/whatsappConnector.test.js` (26), com o simulador e a API HTTP real do conector. Cobre:
  - assinatura inválida (401);
  - envio duplicado, sequencial e concorrente;
  - reuso de requestId;
  - desconectado;
  - número sem WhatsApp;
  - erro de rede incerto;
  - timeout com envio tardio;
  - reinício no meio do envio (vira `unknown`);
  - conector fora do ar;
  - leituras;
  - deduplicação na recepção;
  - Redis fora;
  - ponta a ponta com o CRM fora do ar (o outbox segura e entrega depois).
- `tests/unit/whatsappConnector.noChrome.test.js` (3): o modo externo não cria Chrome, e a ponte não importa o navegador.
- `tests/unit/whatsappInboundProcessor.test.js` (9): as regras de negócio sobre eventos e o envio pela ponte com o deliveryGuard (incerto não reenvia).
- Suíte unitária completa, antes e depois da mudança, rodada na nuvem: as mesmas 46 falhas pré-existentes de ambiente (MongoMemoryServer sem download); nenhuma regressão; +38 testes passando.
