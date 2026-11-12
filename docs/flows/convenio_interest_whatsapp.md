# Interesse em convênio vindo do WhatsApp Web

## O que é

A lista de interesse em convênios (`convenio_waitlist`, tela "Interesse em convênios") recebia só o
formulário do site. Agora também recebe quem falou do convênio (GEAP, Unimed, IPASGO, Bradesco; "bradesco" sozinho também conta e pode trazer conversa do banco, que a equipe descarta) no
WhatsApp Web da clínica. O comercial trabalha uma lista só.

Duas entradas:

| Entrada | Quando | Onde roda |
|---|---|---|
| Varredura do histórico | Botão "Buscar no WhatsApp" na tela (`POST /api/convenio-waitlist/whatsapp-scan`) | Fila `whatsapp-scan`, consumida em `workers/entrypoints/whatsapp-child.js` (crm-worker) |
| Captura ao vivo | Cada mensagem recebida que cita o convênio | Listener `message` em `services/whatsappWebJsService.js` (`handleInboundConvenioInterest`) |

## Por quê

Mensagens recebidas pelo WhatsApp Web não são salvas em Conversas (`Message`) nem criam Lead (só a API
oficial faz isso). Quem perguntou "vocês atendem GEAP?" ficava só no celular. Pedido do Kadu (12/11/2026).

## Regras

- **Só leitura no WhatsApp.** Busca nativa (`client.searchMessages`, a mesma da lupa do app) e, se ela
  falhar ou vier vazia, as mensagens já carregadas no Store. Nunca envia mensagem.
- **Escrita só em `convenio_waitlist`** (e `whatsapp_scan_runs`, que guarda o andamento da varredura).
- **Idempotente por telefone + convênio** (variantes com e sem o 9; o formato antigo é gravado no atual):
  - cadastro ativo (aguardando/contatado) → só completa `whatsapp.*` (trecho, datas, quem citou);
  - cadastro encerrado (agendado/descartado) → não recria;
  - nenhum → cria `status: 'aguardando'`, `channel: 'whatsapp_web'`, `createdAt` = data da 1ª menção.
- `whatsapp.mentionedBy`: `contato` (o paciente citou) e/ou `clinica` (só a clínica citou). O trecho
  guardado prioriza a mensagem do contato.
- Contato `@lid` sem telefone real resolvido é ignorado (conta em `unresolved`).
- Sem consentimento do formulário: `consent.accepted = false` (a pessoa procurou a clínica, não aceitou o termo do site).
- A listagem (`GET /api/convenio-waitlist`) traz `patientMatch` (já é paciente + próxima sessão, com
  `pre_agendado`), só leitura. Filtro novo: `channel=site|whatsapp_web`.
- Uma varredura por convênio por vez: se já há uma `queued`/`running` nas últimas 2h, a rota devolve ela.
- Fora do horário do crm-worker (ADR-022) o job espera no Redis. 3 tentativas com backoff de 1 min.

## Limite e varredura profunda

A busca rápida (`searchMessages`, a lupa do WhatsApp) só enxerga o que já está no navegador: em 12/11/2026 a da GEAP chegou só até 09/09/2026 (~2 meses).

A **varredura profunda** (`POST /whatsapp-scan {deep:true}`, `scanConvenioInterestDeep`) entra em cada conversa individual, puxa do celular as mensagens antigas (`WAWebChatLoadMessages.loadEarlierMsgs`, o "carregar mais") até 3 anos atrás e procura os 4 convênios de uma vez.
- Lotes de 20 conversas; após cada lote grava os interessados e `progress.nextIndex` no `WhatsAppScanRun` (kind `convenio_interest_deep`, convenio `todos`).
- Retomável: worker desliga às 19h10/deploy → o job volta para a fila (`maxStalledCount` 30, 10 tentativas) e continua da próxima conversa.
- Depois de ler cada conversa, tira da memória do navegador as mensagens antigas carregadas (mantém 50) para o Chromium não crescer.
- Uma profunda por vez (dedupe de 7 dias). Depende do celular estar ligado e online para entregar o histórico antigo; `stats.oldest` mostra até onde chegou.
- Palavras incluem erros de digitação comuns (ex.: "iapsgo", "ipago", "unimede").

## Envio em massa (botões "Oferecer particular" e "Agora atendemos")

`POST /api/convenio-waitlist/bulk-offer {kind, convenio?, especialidades?, confirm}` (services/convenioWaitlistOffer.js).
- Sem `confirm: true` é só prévia (nada é enviado). A tela sempre mostra a prévia antes.
- `particular`: status aguardando, pula quem tem sessão futura. `credenciado`: exige convênio; aguardando + contatado. Campos `offer` / `announce` no cadastro marcam o envio (nunca manda o mesmo tipo duas vezes).
- Anti-bloqueio do chip: 1 mensagem por telefone, fila `whatsapp-send` com atraso de ~90s ±15s entre mensagens, teto diário `CONVENIO_OFFER_DAILY_CAP` (padrão 40, soma dos dois tipos), só dia útil 08:00–18:45 (SP).
- O worker marca `sentAt` e passa para `contatado` quando a mensagem sai; falha definitiva grava `error`.

## Desligar

- Captura ao vivo: `WA_CONVENIO_INTEREST_CAPTURE=false` no crm-worker.
- Varredura: não clicar no botão (não há cron).
