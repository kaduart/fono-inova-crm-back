# Conector WhatsApp externo (whatsapp-web.js fora do crm-worker)

Atualizado em 18/11/2026. Decisão do Kadu: manter whatsapp-web.js e tirar o Chrome do crm-worker. Não migrar para Meta Cloud API nem Baileys. PR #85 fica em **rascunho**: sem merge, sem deploy, sem sessão real, sem recurso novo.

Separação de responsabilidades preservada: **CRM** (regras de negócio), **conector WhatsApp** (sessão + Chrome) e **KAS Core** (repositório próprio, `EVENT_REAPER_OWNER`) não se importam entre si. Este trabalho não toca o KAS Core.

## 0. Resumo da entrega

| Item pedido | Estado |
|---|---|
| 1. Servidor real do conector | **Implementado** em `whatsapp-connector/` como projeto separado (motor whatsapp-web.js próprio, contrato HMAC, sessão protegida). Testado com biblioteca falsa e simulador; **nunca** conectado ao WhatsApp real. |
| 2. Memória | Medido e estimado separados (seção 7). Os "250 MB" antigos eram estimativa e saíram. |
| 3. Modo externo nunca abre Chrome | Garantido em 3 pontos e testado, inclusive com o conector fora do ar (seção 5). Falha visível no painel, sem fallback. |
| 4. Reinício, exclusividade e transferência | Seções 8 e 9. Trava de sessão + marcador de transferência + `takeoverOnConflict=false`. |
| 5. Reversão | Seção 11: exige reinício do crm-worker e **volta ao risco de OOM** de antes. |
| 6. Baseline da suíte | Seção 12: main × branch, mesmo comando e ambiente. Nenhuma regressão. |
| Hospedagem | **Bloqueada**: não há capacidade sem custo (seção 2). Nada foi criado. |

## 1. Por quê

Em produção (log do crm-worker, 18/11), o Chrome do whatsapp-web.js usa a maior parte dos 2 GB do serviço, e o processo foi morto por OOM 13 vezes nesse dia, derrubando filas, crons e envios.

A separação **transfere** o Chrome para outro host. Ela não reduz o consumo do Chrome.

## 2. Hospedagem (bloqueio)

| Item | Resultado |
|---|---|
| VPS antiga (`services/whatsappVPSService.js`) | Só cliente HTTP. Sem servidor em nenhum repositório, sem envs no Render. **Inativa**, não reaproveitável. |
| Render sem custo | crm-worker (2 GB, é o que queremos aliviar); API starter (pouca RAM); serviços free 512 MB (Chrome não cabe); um serviço standard **suspenso** (reativar custa). |

Conclusão: **não existe host comprovado a custo zero**. Requisitos do host na seção 7.4.

## 3. O que existe (item 1)

**Antes deste PR:** o "conector" era o próprio `whatsappWebJsService` do CRM rodando com outro papel. Funcionava, mas não era separado (puxava mongoose, models etc.).

**Agora:** `whatsapp-connector/` é um pacote independente (`package.json` próprio, `type: module`).

| Arquivo | Papel |
|---|---|
| `src/index.js` | Processo: valida envs, pega a trava da sessão, sobe HTTP, log de memória a cada 60 s, encerra limpo no SIGTERM. |
| `src/engine.js` | Motor whatsapp-web.js: ciclo de vida do Chrome, QR/ready, reinício com backoff, catch-up, eventos normalizados, envio (texto, enquete com texto alternativo), leituras, varredura profunda. |
| `src/app.js` | API HTTP assinada (seção 4). |
| `src/contract.js` | Assinatura HMAC e formato de eventos. Cópia do `services/whatsappConnector/contract.js`; um teste garante que são idênticos. |
| `src/sessionGuard.js` | Pasta 0700, trava exclusiva, marcador de transferência. |
| `src/idempotencyStore.js`, `src/eventOutbox.js` | Deduplicação de envios e fila de eventos em disco. |
| `src/simulator.js` | WhatsApp falso para ensaio (`WA_CONNECTOR_ENGINE=simulator`). |
| `scripts/import-session.js` | Importa sessão exportada do crm-worker (opção A). |
| `scripts/measure-memory.mjs` | Medição da seção 7. |

Separação comprovada por teste: o conector não importa nada do CRM, e o código de produção do CRM não importa o conector.

Regras de negócio continuam no CRM: normalização de telefone, texto da enquete (`constants/attendancePoll.js`), padrões da varredura de convênio (enviados pelo CRM em cada pedido), origem ctwa, confirmação, votos (`services/whatsappInboundProcessor.js`).

**Repositório separado:** o pacote está pronto para ser movido para um repo próprio (não depende de nada fora da pasta). Criar o repo é com o Kadu.

## 4. Contrato

```
 crm-worker (sem Chrome)                        conector (Chrome + sessão)
 ├─ fila whatsapp-send ──HTTP assinado───────▶ POST /v1/messages (idempotente)
 ├─ fila whatsapp-scan ──HTTP assinado───────▶ /v1/chats/*, /v1/scans/deep-batch
 ├─ ponte: status a cada 5 s ────────────────▶ GET /v1/status → WhatsAppWebState
 └─ worker de eventos ◀─ BullMQ ◀─ API POST /api/whatsapp-connector/events ◀─ outbox em disco
```

**Autenticação (os dois sentidos):** header `x-wa-signature: t=<unix>,v1=<hex>`, com `v1 = HMAC-SHA256(secret, "t.METHOD.path.sha256(body)")`, janela de ±300 s. Segredo ≥32 caracteres; lista por vírgula permite trocar a chave sem parar. Só `GET /v1/health` é aberto.

| Rota | Uso |
|---|---|
| `GET /v1/health` | vivo (aberto) |
| `GET /v1/status` | `{status, ready, authenticated, qrCode, lastDisconnectReason}` |
| `POST /v1/messages` | `{requestId, phone, text, kind, appointmentId?, poll?}` |
| `GET /v1/messages/:requestId` | resultado de um envio (resolve o incerto) |
| `POST /v1/chats/activity`, `/v1/chats/activity-bulk` | data da última conversa |
| `POST /v1/scans/deep-batch` | lote da varredura profunda (`patterns` obrigatório, 1–20 regex) |
| `POST /v1/contacts/resolve-lids` | @lid → telefone |
| `POST /v1/polls/votes` | votos das enquetes |
| `POST /v1/session/reconnect`, `/v1/session/clear` | controle da sessão |

**Envio sem duplicar:**
- Chave única nos dois modos: `wweb:send:<id do job>`. É o `deliveryKey` do `deliveryGuard` (`outbound_deliveries`) e o `requestId` do conector. Trocar de modo no meio de um job não reenvia.
- O conector grava `in_progress → sent | failed | unknown` por requestId (7 dias). Mesmo requestId com mesmo conteúdo devolve o resultado gravado; conteúdo diferente dá 409.
- `NOT_CONNECTED`, `INVALID_NUMBER`, `NO_WHATSAPP`: provado que não saiu.
- Erro no meio do envio (Chrome caiu) ou timeout: **incerto**. O CRM consulta o resultado até 3 vezes; se continuar sem resposta, registra `unknown` e **não reenvia**. Resolução humana pelo fluxo existente.

**Eventos (conector → CRM):** `message.inbound` (`in:<id>`), `message.outbound` (`out:<id>`), `poll.vote` (`vote:<hash>`). Outbox em disco com backoff até 5 min, limite de 20 mil, sobrevive a reinício. A API enfileira com `jobId = wa-evt-<sha256(eventId)>`, então evento repetido não duplica.

## 5. Modo externo nunca abre Chrome (item 3)

Com `WHATSAPP_CONNECTOR_MODE=external` no crm-worker:

1. `whatsapp-only.js` não cria o processo filho com Chrome (`shouldSpawnChromeChild` em `workers/entrypoints/whatsappMode.js`).
2. `initWhatsAppClient` retorna sem criar Client e `createClient` lança erro (`localChromeForbidden`). Reconexão, softReconnect e retentativas passam por esses pontos.
3. Se a ponte não sobe, o status vira `connector_bridge_failed` e tenta de novo a cada 15 s a 5 min. **Sem fallback** para Chrome local.

Com o conector fora do ar:
- Depois de 3 consultas sem resposta, o status vira `connector_unreachable` com `lastDisconnectReason: "conector sem resposta: ..."`.
- O envio falha como "não saiu" e o BullMQ tenta de novo depois. Nada é marcado como enviado.
- O painel (`WhatsAppConnectionCard`) mostra o status como desconhecido e exibe "Última desconexão: conector sem resposta", então a falha fica visível.

Testes: `tests/unit/whatsappConnector.noChrome.test.js` (9). Boot, reconexão, softReconnect e envio não constroem nenhum Client; o guard do spawn só cria um filho no modo local; conector inalcançável gera `connector_unreachable` e envio rejeitado como não saiu; marcador gera `session_transferred`; grafos de import separados; contrato idêntico.

Acoplamento que sobra (documentado): no modo externo o processo pai ainda **carrega o módulo** whatsapp-web.js (via `whatsappService` → `whatsappWebJsService`), mas nunca abre o navegador. A medição da seção 7 já inclui esse custo.

## 6. Variáveis de ambiente

CRM:

| Variável | Onde | Valor |
|---|---|---|
| `WHATSAPP_CONNECTOR_MODE` | crm-worker | `external` liga o modo externo; ausente mantém o modo local de hoje |
| `WA_CONNECTOR_URL` | crm-worker | URL base do conector (https) |
| `WA_CONNECTOR_SECRET` | crm-worker **e API** | o mesmo do conector, ≥32 caracteres |
| `WA_CONNECTOR_TIMEOUT_MS` | crm-worker | leituras, padrão 15000 |
| `WA_CONNECTOR_SEND_TIMEOUT_MS` | não definir | padrão 100000 no CRM e 90000 no conector; o do CRM tem que ser maior |

Conector:

| Variável | Valor |
|---|---|
| `WA_CONNECTOR_SECRET` | o mesmo do CRM |
| `CRM_EVENTS_URL` | `https://.../api/whatsapp-connector/events` (http é recusado, salvo `WA_ALLOW_HTTP_EVENTS=true` em ensaio) |
| `WA_CONNECTOR_DATA_DIR` | disco persistente, padrão `/var/data/wa-connector` |
| `WHATSAPP_AUTH_PATH` | padrão `<DATA_DIR>/wwebjs_auth` |
| `WA_CONNECTOR_ID` | nome nos eventos e na trava, padrão `main` |
| `PORT` | padrão 8787 |
| `PUPPETEER_EXECUTABLE_PATH` ou `CHROME_PATH` | Chrome fixado (157.0.8103.38, o mesmo de `config/chromeVersion.js`) |
| `WHATSAPP_CHROME_JS_HEAP_MB` | teto do heap JS da página, padrão 1024 |
| `WA_CONNECTOR_SEND_MIN_INTERVAL_MS` | intervalo entre envios, padrão 1000 |
| `WA_TAKEOVER_ON_CONFLICT` | **não definir** (padrão false, seção 9) |
| `WA_SESSION_TAKEOVER` | só para assumir trava de outro host, com o nome dele (seção 9) |

Instalação no host: `cd whatsapp-connector && npm install` (gera o lockfile; aqui na nuvem o tarball do GitHub do whatsapp-web.js é bloqueado) e `npm start`.

## 7. Memória: medido × estimado (item 2)

### 7.1 Produção, medido (log do crm-worker, 18/11, 20:27–20:48 UTC, só leitura)

| Parte | RSS |
|---|---|
| Node pai | 172–179 MB |
| Node filho (whatsapp) | 138–172 MB |
| Árvore do Chrome (8–9 processos) | 1816–2004 MB: renderer 968–1218, browser 379–461, utility ~260, gpu ~138 |
| cgroup do serviço | **1494–1697 MB de 2048 MB** |
| OOM | 13 vezes em 18/11, no limite de 2 GB |

A soma dos RSS (~2,2 GB) passa do cgroup porque RSS conta páginas compartilhadas mais de uma vez. O número que decide OOM é o cgroup.

### 7.2 Local, medido (nuvem, 18/11)

crm-worker no modo externo (`scripts/medir-memoria-worker-externo.mjs`, 3 rodadas; imports reais do processo pai, sem BullMQ/Redis/Mongo reais):

| Cenário | RSS |
|---|---|
| Imports do pai | 174–187 MB |
| + ponte do conector | 175–187 MB |
| Carga sintética: 1000 envios a um conector simulado (outro processo) + 5000 eventos recebidos, pico | 197–215 MB |
| Depois do GC | 176–182 MB |

Conector (`whatsapp-connector/scripts/measure-memory.mjs`, 2–3 rodadas):

| Cenário | RSS |
|---|---|
| Node com o motor real carregado, sem Chrome | 78–80 MB |
| Processo do conector com simulador, parado | 49–50 MB |
| Idem, pico com 1000 envios | 67–68 MB |
| Piso do Chrome (Chrome for Testing 153, mesmas flags, `about:blank`, **sem WhatsApp**) | 6 processos, RSS 739–754 MB, PSS 309–310 MB |

O WhatsApp Web não abre aqui (o proxy da nuvem bloqueia `web.whatsapp.com` com 403). Por isso o Chrome **com** WhatsApp não foi medido localmente; o dado real é o de produção (7.1).

### 7.3 Estimativas (não comprovadas)

| Item | Estimativa | Base |
|---|---|---|
| crm-worker no modo externo, em produção | ~200–215 MB | pai medido em produção + pico da ponte medido localmente. Falta medir com filas reais. |
| Host do conector, regime | ~1,15–1,4 GB | cgroup de produção menos os dois Node (conta aproximada) + ~80 MB do Node do conector |
| Host do conector, picos | desconhecido, acima de 2 GB | o processo morria no limite, então o pico real nunca foi visto |

### 7.4 Host do conector

Mínimo 2 GB, confortável **2,5–3 GB** de RAM, 1 vCPU, disco persistente ≥1 GB, HTTPS de entrada.

## 8. Reinício (item 4)

Dentro do processo do conector:
- Desconexão, página travada, navegador fechado ou erro de página: destrói o Chrome e recria com espera de 10 s, 30 s, 60 s, 120 s, 300 s.
- `initialize` travado: watchdog destrói e reinicia.
- Mais de 8 reinícios em 30 min: status `failed`, para de abrir Chrome e espera o botão Reconectar do painel.
- `CONFLICT` (a mesma sessão aberta em outro lugar): status `conflict`, **para e não retoma sozinho**. Só retoma pelo Reconectar.

Do processo inteiro (deploy, queda do host):
- Ao subir, envios que estavam `in_progress` viram `unknown` (nunca reenviados sozinhos).
- O outbox de eventos continua de onde parou.
- O catch-up relê as conversas recentes para não perder origem de anúncio.
- No SIGTERM, fecha o Chrome e libera a trava.

## 9. Exclusividade da sessão (item 4)

CRM e conector **nunca** podem abrir a mesma sessão ao mesmo tempo. Três travas:

1. **Trava em disco** `.connector-lock.json` (criação exclusiva, 0600) na pasta da sessão do conector. Outro processo vivo no mesmo host: o conector não sobe. Processo morto no mesmo host: a trava é recuperada. Trava de **outro host**: só assume com `WA_SESSION_TAKEOVER=<nome daquele host>`.
2. **Marcador de transferência** `.session-transferred.json` na pasta da sessão de origem. Com ele, o crm-worker no modo local **não abre Chrome** (status `session_transferred`) e o conector também não sobe naquela pasta.
3. **`takeoverOnConflict=false`** no whatsapp-web.js: se as duas pontas abrirem a sessão, nenhuma derruba a outra; quem detectar o conflito para e mostra `conflict`.

Pastas da sessão com permissão 0700 e umask 077 (só o dono lê).

## 10. Transferência segura (item 4)

**Recomendada: opção B (QR novo).** Não copia credencial entre máquinas.

1. crm-worker com `WHATSAPP_CONNECTOR_MODE=external` e reiniciado (o Chrome local deixa de existir).
2. No shell do crm-worker:
   `node scripts/whatsapp-session-handoff.js release --to <id do conector>`
   Recusa se o worker ainda estiver em modo local ou se houver Chrome usando a pasta. Grava o marcador.
3. Subir o conector com pasta vazia e escanear o QR pelo painel.
4. No celular, remover o aparelho vinculado antigo.

**Opção A (copiar a sessão):**

1. Passos 1 e 2 acima, com `--export /tmp/sessao.tgz`. O arquivo sai 0600, sem caches, e o script imprime o sha256.
2. Copiar para o host do conector (scp) e, **com o conector parado**:
   `node scripts/import-session.js --archive /tmp/sessao.tgz --sha256 <hash>`
   Confere o hash, recusa caminhos perigosos, pega a trava, extrai com permissão só do dono. Sessão existente só é trocada com `--replace` (a anterior vira `.bak-<data>`).
3. Apagar o arquivo nas duas pontas com `shred -u`.

Status a qualquer momento: `node scripts/whatsapp-session-handoff.js status`.

## 11. Reversão (item 5)

1. Parar o conector.
2. No shell do crm-worker:
   `node scripts/whatsapp-session-handoff.js reclaim --confirm-connector-stopped`
   Recusa se `WA_CONNECTOR_URL/v1/health` ainda responder. Remove o marcador.
3. No Render, **remover** `WHATSAPP_CONNECTOR_MODE` do crm-worker. Mudar env reinicia o serviço; Manual Deploy só se o código também mudou. **Sem esse reinício, o worker continua em modo externo.**
4. Sessão:
   - Opção A: a cópia local pode estar velha; se não conectar, escanear o QR.
   - Opção B: a sessão local antiga pode ainda estar vinculada; se não, escanear o QR.
   - Remover no celular o aparelho do conector.
5. Envios `unknown` continuam em `outbound_deliveries` para resolução humana. Eventos que ficaram no outbox do conector são cobertos pelo catch-up local e pela deduplicação.

**Risco:** ao voltar, o filho e o Chrome voltam para dentro do crm-worker. O cgroup volta a ~1,5–1,7 GB de 2 GB, com **o mesmo risco de OOM de antes** (13 em 18/11), derrubando filas e crons junto.

Não há migração de banco. Só a fila `whatsapp-connector-events` no Redis.

## 12. Testes e baseline (item 6)

### 12.1 Baseline da suíte do CRM (main × branch)

Mesmo comando, mesmo ambiente (nuvem, mesmas dependências em `node_modules`):

```
npx vitest run tests/unit services utils domains --reporter=json --outputFile=<arquivo>
```

| | main `761018f` | branch `e8b265b` |
|---|---|---|
| Arquivos | 193 (53 falham) | 197 (53 falham) |
| Testes | 2008 | 2057 |
| Passaram | 1742 | **1791** |
| Falharam | 5 | 5 (os mesmos) |
| Pulados / todo | 251 / 10 | 251 / 10 |

- Arquivos que falham só na branch: **nenhum**. Casos que passavam na main e falham na branch: **nenhum**.
- 4 arquivos novos: `whatsappConnector.noChrome`, `whatsappConnector`, `whatsappInboundProcessor`, `whatsappSessionHandoff`.
- Os 5 casos que já falham na main: appointment-client-fields-contract (DTO), completeWorker.safety (liberação de lock), insuranceGuidesApi (formato `{ guide, lifecycle }`), packageTransferCanonicalRules (estorna Payment), production-fixes P4 ChatContext.
- Os 53 arquivos que já falham na main: 27 por MongoMemoryServer (download do binário bloqueado na nuvem); 10 falham em casos; o resto é problema do próprio teste (módulo `flagsDetector.js` ausente, mock sem `THERAPY_PRICING`, `@jest/globals`, "No test suite found", `vi`/`beforeEach` não definidos, `process.exit`).

O CI do GitHub roda com Mongo e Redis reais e é um sinal **diferente**: verde lá não prova ausência de regressão nesses 53 arquivos que o ambiente local não roda, e vice-versa.

### 12.2 Outras suítes

| Comando | Resultado |
|---|---|
| `cd whatsapp-connector && npm test` | 26/26 (trava de sessão 7, motor 11, subida do processo 4, import de sessão 4) |
| `node --test tests/delivery/sendPathsInventory.nodetest.mjs` | 6/6 (a ponte está no inventário de envios protegidos) |
| `npx vitest run` nos 9 arquivos ligados ao WhatsApp | 82/82 |

O CI ganhou o job `conector-whatsapp` (`npm test` em `whatsapp-connector/`).

### 12.3 O que foi testado × o que depende da sessão real

Testado de verdade (local, sem WhatsApp):
- contrato HMAC, deduplicação, incerto, timeout, reinício no meio do envio, outbox, recepção na API;
- motor com biblioteca whatsapp-web.js **falsa**: ciclo de vida, reinício, watchdog, conflito, limite de reinícios, eventos normalizados, envio e enquete;
- processo real do conector subindo com simulador; recusa de segredo curto, http, trava viva e sessão transferida;
- modo externo sem Chrome, inclusive com o conector fora do ar;
- exportação e importação de sessão com hash, permissões e trava;
- memória dos Node e piso do Chrome sem WhatsApp.

Depende da sessão real (não testado):
- comportamento do WhatsApp Web de verdade: QR, `ready`, `CONFLICT`, desconexões;
- bytes reais do `ctwaContext` (origem de anúncio), enquetes e votos;
- varredura profunda executada dentro da página;
- memória do Chrome com o WhatsApp carregado neste host;
- portabilidade da sessão copiada entre hosts (opção A).

## 13. Procedimento de troca (para validação do Kadu; nada foi feito)

Pré-requisito: host para o conector (bloqueado, seção 2).

1. Ensaio no **espelho** com `WA_CONNECTOR_ENGINE=simulator` e o crm-worker do espelho em modo externo.
2. Merge e deploy com a variável desligada (nada muda).
3. Subir o conector no host novo, sem sessão; conferir `/v1/health`; colocar `WA_CONNECTOR_SECRET` na API e no worker.
4. Janela fora do horário de atendimento: modo externo no worker → transferência (seção 10) → esperar `ready` → mensagem de teste.
5. Monitorar 24 h: memória dos dois lados, `outbox-dead.jsonl` vazio, nenhum `unknown` novo, log `📣 ctwaContext recebido (conector)` nas conversas de anúncio.
