# ADS_CONVERSION_CONTRACT

> Loop de conversão offline/server-side: devolve às plataformas de anúncio (Meta, Google, TikTok)
> **quem agendou** — não quem só clicou — para que o algoritmo otimize por lead qualificado.
> Antes de alterar, leia `DOMAIN_INVARIANTS.md`. Mudança deve ser incremental e compatível com dado antigo.

## 1. Objetivo

Campanhas de clique/mensagem otimizam, por padrão, por **quem clica ou inicia conversa** (curioso).
Enviando o evento de **agendamento** de volta ao algoritmo, ele passa a procurar pessoas parecidas
com **quem realmente agenda**. É o que destrava, na Meta, o objetivo de otimização por conversão.

## 2. Arquitetura (por que cron, não evento)

`APPOINTMENT_CONFIRMED` não tem fila consumidora e agendamentos entram por vários caminhos
(agenda externa, `importFromAgenda`, V2). Um cron varre `Appointment.createdAt` e pega todos.

```
Appointment (pre_agendado+)  ─┐
                              ├─(cron 10min)→ AdConversion (outbox)  ─(cron)→ Meta CAPI
leadAttribution (por telefone)┘                                              → Google Ads (offline)
                                                                             → TikTok Events API
```

- **Cron:** `crons/adsConversion.cron.js` (registrado em `config/cronManager.js`, gated por `ENABLE_ADS_CONVERSION`).
- **Outbox:** model `models/AdConversion.js` — 1 doc por agendamento, `unique(appointment)` = idempotência.
- **Services de envio:** `services/metaConversionsService.js`, `services/googleAdsConversionsService.js`,
  `services/tiktokConversionsService.js`.
- **Atribuição:** `services/leadAttributionService.js` (`getAttributionByPhone`).

### Etapas do cron (`runOnce`, a cada 10 min)
1. `enqueueNew()` — pega agendamentos (15 min a 30 dias), resolve origem por telefone, grava `AdConversion`.
   Só o **1º agendamento do paciente** é enviado (demais → `skipped`).
2. `refreshUnknownSources()` — reatribui docs `source=unknown` quando a origem chega depois; reabre o envio
   da plataforma cujo clickId surgiu (Google 90d / TikTok 7d).
3. `processPending()` — envia pendentes com retry/backoff (20m, 40m, 80m, 160m; máx 5 tentativas).

## 3. Cadeia de atribuição do clickId (como o ttclid chega)

1. **Site** (`site/src/hooks/useLeadTracking.js`): captura `gclid`/`fbclid`/`ttclid` da URL → localStorage →
   `buildTrackingPayload().metaTracking` enviado ao CRM na criação do lead.
2. **CRM** (`controllers/leadController.js`): persiste em `Lead.metaTracking.{gclid,fbclid,ttclid}`.
3. **WhatsApp inbound** (`utils/attributionParser.js` + `leadAttributionService.js`): CTWA (`ctwaClid`),
   token `(TK/IG/FB/GG)`, assinatura `---ref:` ou palavra-chave.
4. `getAttributionByPhone(phone)` resolve a origem (LeadAttribution → Lead.metaTracking) e devolve
   `{ source, gclid, fbclid, ttclid, adId, campaign, ... }` para o cron.

> **Gap conhecido:** a assinatura no WhatsApp (`buildWhatsAppRefSignature`) está DESATIVADA (retorna '').
> Logo, `ttclid` só chega via **formulário do site** (BookingModal). Clique no botão de WhatsApp direto
> NÃO carrega o ttclid. Alternativa nativa: anúncio **CTWA** (carrega `ctwa_clid` sozinho).

## 4. Mapa de evento por plataforma

| Plataforma | Evento enviado | Identificador | Janela | Token/ID no `.env` |
|---|---|---|---|---|
| Meta (CAPI) | `Purchase` (`action_source: physical_store`) | telefone (SHA-256) + `fbc` | 7 dias | `META_PIXEL_ID`, `META_CONVERSIONS_TOKEN` |
| Google Ads | offline conversion | `gclid` | 90 dias | `GOOGLE_ADS_*`, `GOOGLE_ADS_CONVERSION_ACTION_ID` |
| TikTok (Events API v1.3) | `Schedule` | telefone (SHA-256 E.164) + `ttclid` | 7 dias | `TIKTOK_EVENTS_TOKEN`, `TIKTOK_PIXEL_ID` (default DB3PQARC77UA626EKV60) |

- `event_id = appt_<appointmentId>` em todas → dedupe/idempotência na plataforma.
- `value = Appointment.sessionValue` ou `ADS_CONVERSION_DEFAULT_VALUE` (220).
- TikTok Events API: `POST /open_api/v1.3/event/track/`, header `Access-Token`,
  body `{ event_source:'web', event_source_id:<pixel>, data:[{ event, event_time, event_id, user:{phone,ttclid}, properties:{value,currency} }] }`.

## 5. Privacidade (INVARIANTE — nunca quebrar)

O payload enviado às plataformas contém **apenas**: telefone (hash SHA-256), valor comercial,
id do agendamento e origem (`source`). **NUNCA** condição clínica, diagnóstico, especialidade ou nome.
Clínica infantil/TEA: enviar dado de saúde = risco de ban + violação de política das plataformas.

## 6. Como ligar / operar

```bash
# .env
ENABLE_ADS_CONVERSION=true        # liga o cron (default: desligado)
ADS_CONVERSION_DRY_RUN=true       # 1ª vez: só loga, não grava nem envia (validar antes de ligar de vez)
ADS_CONVERSION_DEFAULT_VALUE=220
TIKTOK_EVENTS_TOKEN=...            # Events Manager > pixel > Settings > Generate access token
# Meta (quando resolver bloqueio de dado de saúde do dataset):
# META_PIXEL_ID=...
# META_CONVERSIONS_TOKEN=...
```

Recomendação de rollout: `ADS_CONVERSION_DRY_RUN=true` por 1 dia → conferir logs `[AdsConversion] [DRY]`
→ depois `ENABLE_ADS_CONVERSION=true` sem dry-run.

## 7. Pendências (status em 2026-10-22)

- **TikTok:** token configurado; envio pronto. (validação ao vivo só roda no servidor — sandbox bloqueia a rede da API.)
- **Meta:** faltam `META_PIXEL_ID` + `META_CONVERSIONS_TOKEN` no `.env`; dataset do site bloqueado por
  categorização de dado de saúde + conta em erro de pagamento. Enquanto não resolver, Meta fica `skipped/failed`.
- **Google:** credenciais presentes; depende de `GOOGLE_ADS_CONVERSION_ACTION_ID`.
- **Volume:** otimizar campanha pelo evento de maior volume (agendou) — clínica não fecha ~50 compras/semana
  que a Meta exige para sair do aprendizado otimizando por compra.
