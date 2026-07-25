# RCA — Reconstrução do WhatsApp Web (Julho/2026)

**Data do incidente:** 24–25/07/2026  
**Data da resolução:** 25/07/2026  
**Serviço afetado:** Worker WhatsApp Web (`whatsapp-only` / `whatsapp-child.js`)  
**Ambiente:** Render + Persistent Disk + Chrome Puppeteer  
**Branch de resolução:** `whatsapp-rebuild`  
**Baseline funcional:** `a7b8bdd7`

---

## Resumo executivo

O serviço de WhatsApp Web parou de enviar mensagens de forma confiável. Durante a investigação foram testadas várias hipóteses (memória, sessão corrompida, Chromium, versão da biblioteca) e adicionadas várias camadas de mitigação (retries, fallback, detector de congelamento, etc.).

A evidência decisiva veio do deploy do commit `a7b8bdd7` (baseline funcional conhecido): com a **mesma sessão**, **mesmo Render** e **mesmo Chrome**, o WhatsApp voltou a enviar mensagens imediatamente.

A partir disso, o serviço foi reconstruído incrementalmente no branch `whatsapp-rebuild`, mantendo apenas as melhorias úteis e descartando as mitigações que introduziram regressão.

---

## Sintoma

Mensagens enfileiradas na fila `whatsapp-send` falhavam no envio. Os erros observados ao longo da investigação incluíam:

```text
Runtime.callFunctionOn timed out
```

```text
Timeout: getNumberId(5561981694922) (30000ms)
```

```text
Waiting failed
    at Client.inject
    at Client.initialize
```

O processo child continuava vivo, heartbeat normal, memória estável (~135–150 MB RSS), mas chamadas específicas dentro da página do WhatsApp Web travavam.

---

## Hipóteses investigadas

| Hipótese | Evidência | Conclusão |
|----------|-----------|-----------|
| Memória cheia | RSS ~135 MB, container com 37–50 GB livres | Descartado |
| CPU saturada | Heartbeat regular, processo responsivo | Descartado |
| Sessão corrompida | Limpeza de sessão + novo QR não resolveu | Descartado |
| Chromium específico do Render | Mesmo Chrome funcionou no baseline | Descartado |
| Incompatibilidade `whatsapp-web.js` × WhatsApp Web | Possível, mas baseline com mesma versão funcionou | Parcial |
| Regressão introduzida por commits após `a7b8bdd7` | **Baseline funcionou imediatamente** | **Mais provável** |

---

## Experimentos realizados

1. Limpeza de sessão e novo QR.
2. Aumento de timeouts e retries.
3. Fallback para envio direto `@c.us`.
4. Detector de página congelada (`pingPage`, `softReconnect`).
5. Limpeza de cache temporário do Chrome.
6. Rollback do `whatsapp-web.js` para versões anteriores.
7. **Deploy do commit `a7b8bdd7` — funcionou imediatamente reutilizando a sessão existente.**

---

## Evidência decisiva

```text
2026-07-25T19:24:07.857Z  [WhatsAppWeb] Sessão preservada — FORCE_CLEAN desativado.
2026-07-25T19:24:25.850Z  [WhatsAppWeb] ready — WhatsApp conectado!
2026-07-25T19:25:17.641Z  [WhatsAppWeb] ✅ Enviado para 5561981694922 — ID: unknown
```

Mesmo número, mesma sessão, mesmo ambiente. A diferença foi o código deployado.

---

## Causa raiz provável

Uma ou mais alterações introduzidas após `a7b8bdd7` — provavelmente as mitigações agressivas (retries em cascata, `Promise.race`, detector de congelamento, `softReconnect` com `evaluate` na página) — deixaram o serviço em um estado instável. Essas mudanças podem ter competido com o ciclo de vida interno do `whatsapp-web.js` e do Chromium, causando travamentos nas chamadas de envio.

A versão da biblioteca `whatsapp-web.js` também foi alterada para um SHA específico (`pedroslopez#1780711a`) durante a investigação; o baseline usa a branch `main` oficial (`wwebjs/whatsapp-web.js#main`).

---

## Melhorias mantidas no `whatsapp-rebuild`

### 1. Limpeza automática e manual de cache temporário do Chrome
- Preserva `IndexedDB`, `Local Storage` e autenticação.
- Remove caches de rede, GPU, Service Worker, etc.
- Threshold padrão: **1500 MB** (disco do Render ampliado para 5 GB).
- Rota manual: `POST /api/admin/whatsapp-queue/cleanup-cache`.

### 2. Health endpoint simples
- `GET /api/health/whatsapp`
- Apenas leitura de `whatsappState` + fila `whatsapp-send`.
- Não inicializa cliente, não executa `evaluate`, não toca na sessão.

### 3. Filtro de ruído `pageerror`/`console`
- Suprime logs comuns do WhatsApp Web/Chromium (CSP, WebSocket, `Failed to load resource`, etc.).
- Mantém erros reais visíveis.

### 4. Heartbeat e métricas de memória
- RSS/Heap do child e memória do container.
- `childReady`, `pid`, `uptime`.

---

## Mitigações removidas

Não foram reintroduzidas no `whatsapp-rebuild`:

- ❌ Retries em cascata no `getNumberId()`.
- ❌ Timeout artificial com `Promise.race`.
- ❌ Fallback automático para `@c.us`.
- ❌ Detector de página congelada (`pingPage`).
- ❌ `softReconnect` complexo.
- ❌ Diagnósticos no fluxo normal de envio.
- ❌ Resolução obrigatória de LID/PN.

O envio voltou a ser simples: `client.sendMessage(phone@c.us, message)`.

---

## Ações pós-incidente

1. **Mergear `whatsapp-rebuild` no `main`** de forma cirúrgica, mantendo o inventário acima.
2. **Atualizar o frontend** apenas se necessário (remover dependências de status `frozen`, etc.).
3. **Remover código morto**, variáveis de ambiente sem uso e endpoints de diagnóstico temporários.
4. **Documentar a política:** no WhatsApp Web, menos intervenção no ciclo de vida da biblioteca é melhor.

---

## Lições aprendidas

- Quando uma regressão aparece, o experimento mais rápido é voltar para o último estado comprovadamente estável.
- Mitigações acumuladas durante investigação podem se tornar a causa de novos problemas.
- A fila BullMQ, o Redis e o processo child estavam saudáveis; o gargalo estava no runtime do Chromium/WhatsApp Web.
- Sessão persistida em disco + LocalAuth continua sendo a estratégia mais confiável.
