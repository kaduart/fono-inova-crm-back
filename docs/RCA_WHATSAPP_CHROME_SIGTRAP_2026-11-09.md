# RCA — WhatsApp Web preso em "Inicializando" (Chrome 151 morre com SIGTRAP)

**Data do incidente:** 09/11/2026 (detectado ~12h, resolvido ~15h BRT)
**Serviço afetado:** `crm-worker` (entrypoint `workers/entrypoints/whatsapp-only.js`)
**Biblioteca:** `whatsapp-web.js` 1.34.7 · puppeteer-core 24.43.1
**Chrome:** 151.0.7922.77 (pinado em `config/chromeVersion.js`) → 157.0.8103.38

---

## Sintoma

- Modal "Conectar WhatsApp" da agenda externa preso em "Inicializando…"; botão "Gerar novo QR" sem efeito.
- Nenhum deploy entre 26/10 e 09/11: a quebra veio de fora (WhatsApp Web).
- Log: `initialize()` resolvia em ~10s (sessão reconhecida), e 5s depois só
  `Attempted to use detached Frame '…'` a cada 15s, até o watchdog reiniciar em 240s. Em loop.

## Investigação (ordem real)

1. **PR #36** — hipótese: corrida do `change:hasSynced` (ready nunca emitido). Adicionou watchdog de init e o kick `onAppStateHasSyncedEvent`. Não resolveu; expôs o `detached Frame`.
2. **PR #37** — hipótese: a página recarrega e o Puppeteer perde o frame. Adicionou recuperação abrindo aba nova no mesmo perfil. Falhou com `Connection closed` ao listar abas → o **processo do Chrome** tinha morrido, não só a aba.
3. **PR #38** — `dumpio: true` (stderr do Chrome no log) + `browser.on('disconnected')` + log de `code/signal` do processo. Log de prod:

```text
14:49:42.912 [CHILD] 🟢 WhatsApp inicializado
14:49:43.096 [...crashpad/util/file/file_io_posix.cc:145] open /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq ...
14:49:43.606 [WhatsAppWeb] 💥 Conexão com o Chrome perdida (status=initializing, ready=false).
14:49:43.613 [WhatsAppWeb] 💥 Processo do Chrome saiu: code=null signal=SIGTRAP
```

Reproduzível em 100% dos boots: o Chrome 151 crasha (SIGTRAP = CHECK interno do Chromium) ~0,2s depois que o WhatsApp Web termina de carregar. Builds oficiais não imprimem a mensagem do CHECK, então a causa exata dentro do Chromium não é visível; o gatilho é o novo build do WhatsApp Web.

## Correção

- Teste sem deploy: env `CHROME_VERSION=157.0.8103.38` no `crm-worker` (Render refaz o build; `installChrome.js` lê a env via `config/chromeVersion.js`).
- Resultado (14:59): Chrome 157 não cai, `socket.state=CONNECTED`, `loading_screen` progride, **sessão reaproveitada sem QR**.
- Pin atualizado no código para `157.0.8103.38`; a env pode ser removida depois do deploy (fica como override para testes futuros).

## Como diagnosticar de novo (rápido)

1. Logs do `crm-worker` via API do Render (`GET /v1/logs?ownerId=…&resource=srv-d7f4q5svikkc73c9n1bg&text=WhatsAppWeb`). Chave em `RENDER_API_KEY`.
2. Procurar `💥 Processo do Chrome saiu` — se houver `signal=SIGTRAP`/`SIGSEGV` logo após `🟢 WhatsApp inicializado`, é o Chrome × WhatsApp Web: trocar `CHROME_VERSION` para o estável atual (Chrome for Testing, `storage.googleapis.com/chrome-for-testing-public/<versão>/linux64/chrome-linux64.zip` deve responder 200).
3. Se o Chrome não cai mas não chega em `ready`, ver `🔎 pós-init: socket=` (estado e `hasSynced`) e a RCA de IndexedDB (`WHATSAPP_IDB_QUOTA_RCA.md`): plano B é `WHATSAPP_FORCE_CLEAN_SESSION=true` (QR novo; voltar para `false` depois).

## Lições

- Serviço sem deploy que quebra = mudança externa (WhatsApp Web / Chrome). Olhar o processo do Chrome antes de mexer na lib.
- `dumpio` fica ligado por padrão: o custo é ruído de dbus no log; o ganho é ver o crash.
- Pin de Chrome é necessário (versões aleatórias já quebraram), mas precisa de um caminho de troca sem deploy — a env `CHROME_VERSION` é esse caminho.
- Confusão operacional: o deploy manual precisa ser no **crm-worker**, não na API (`fono-inova-crm-back`); conferir o commit do deploy do worker pela API do Render.
