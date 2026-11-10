# Agendamento público (link da bio do Instagram)

Criado em 10/11/2026. Pedido do Kadu: "link de agendamento no Instagram direto".

## O que é

A família abre o link da bio/stories → página `/agendar` do site (fono-inova-web) → escolhe especialidade, **dia e período (manhã/tarde)** → deixa nome e nascimento da criança, nome e WhatsApp do responsável → o ERP cria um **pré-agendamento** (`pre_agendado`) que cai na triagem da secretária (`/api/v2/pre-appointments`). A secretária confirma o horário exato pelo WhatsApp.

Decisão do Kadu (10/11): a página mostra **só dia + período**, nunca o horário exato nem o profissional (regra "só horários genéricos"). O sistema trava por dentro o primeiro horário livre do período.

## Rotas (`routes/publicBooking.js`, montado em `/api/public/booking`, SEM login)

| Rota | O que faz |
|---|---|
| `GET /options?specialty=&from=&days=` | dias (amanhã até 14 dias) com `periods: [{ period: 'manha'|'tarde', available }]`. Cache 60 s no Redis. |
| `POST /hold` | cria a reserva. Corpo: `specialty, date, period, child{fullName,birthDate}, responsible{name,phone}, consentLgpd, utm{source,medium,campaign,content}, captchaToken, website` (isca). `201 { code, display }`, `409 PERIOD_FULL { alternatives }`, `400 VALIDATION { fields }`, `429`, `503 DISABLED/DAILY_CAP`. |
| `GET /:code` | `{ status: reservado|confirmado|encerrado, display }`. Sem dado pessoal. |

## Variáveis de ambiente (Render, serviço da API)

| Variável | Padrão | Uso |
|---|---|---|
| `PUBLIC_BOOKING_ENABLED` | desligado | `true` liga as rotas. Desligado → 503 e a página mostra só o WhatsApp. |
| `TURNSTILE_SECRET_KEY` | vazio | captcha Cloudflare Turnstile. Vazio = sem captcha (valem isca, rate limit e teto). |
| `PUBLIC_BOOKING_DAILY_CAP` | 15 | máximo de reservas online por dia. |
| `PUBLIC_BOOKING_SPECIALTIES` | fono, psico, TO, neuropsico, psicopedagogia, fisio | especialidades liberadas (valores do enum de `Doctor.specialty`). |

No site: `VITE_TURNSTILE_SITE_KEY` (chave pública do Turnstile) e o `VITE_CRM_API_URL` que já existe.

## Regras

- **Escolha do horário**: só profissionais ativos da especialidade com horário configurado no dia (`weeklyAvailability`; sem configuração não entra). Ignora horário ocupado, feriado e horário "sombra" de paciente recorrente (`signals.isShadow`). Escolhe o profissional com mais horários livres no dia e o primeiro horário do período; revalida com `checkSlotOverlap` e trava 20 s no Redis.
- **Anti-duplicado**: `findPossibleDuplicates` + `pickReusableDuplicate` (docs/PATIENT_DUPLICATES.md). Paciente novo nasce com `source: 'link_agendamento'` e `possibleDuplicateOf` quando houver suspeita. Mesmo telefone + mesma criança com reserva ativa → devolve a mesma reserva.
- **Limites**: por IP (options 60/10 min, hold 5/h, status 30/10 min), por telefone (2 reservas/24 h) e teto diário.
- **Sem vazamento**: nenhuma resposta traz ids, profissional, contagem de vagas ou se o paciente já existia. Logs só com os 4 últimos dígitos do telefone.
- **Financeiro**: nada. `sessionValue: 0`, `billingType: 'particular'`, `serviceType: 'evaluation'`; o valor é definido na confirmação. Convênio e liminar não entram pelo link (a página manda para o WhatsApp).
- **Sem Amanda/lead**: não cria Lead nem dispara mensagem automática (invariante "Amanda nunca dispara sem contexto").
- **Origem (ROI)**: `metadata.origin.source` = `instagram` (utm_source contém instagram) ou `site`; `metadata.origin.channel = 'link_agendamento'`, `bookingCode` e `utm`. Índice sparse em `metadata.origin.bookingCode`.
- **Expiração**: o cron `preAgendamentoExpiration` já fecha pré-agendamentos cujo horário passou. Reserva do link não confirmada fica na triagem como qualquer pré.

## Testes

- `tests/unit/publicBooking.test.js` — regras puras, captcha e rota (sem banco).
- `tests/unit/publicBooking.service.test.js` — Mongo real: cria, idempotência, limite por telefone, período lotado, teto diário, options sem profissional. Local: `TEST_MONGO_URI=mongodb://127.0.0.1:27017` com Redis rodando.

## Também neste PR

`GET /api/import-from-agenda/diagnostico/:patientName` e `GET /api/import-from-agenda/auditar-unimed` estavam sem login e devolviam dados de pacientes. Agora exigem `flexibleAuth + requireAdmin`.
