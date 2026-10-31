# Espelho na nuvem: cópia produção → DEV (seg–sex 20:00)

**O que é:** cópia anonimizada da produção num banco de DEV exclusivo (Atlas M0 separado), para testar com cenários reais.
**Código:** `services/espelho/espelhoSync.js` (núcleo) · `crons/espelhoSync.cron.js` (agenda) · `scripts/espelho/sync-nuvem.mjs` (CLI) · `scripts/espelho/anonimizar.mjs`.

## Quando e onde roda
- Serviço **crm-backend** (Render), via `startAllCrons()`. Agenda `0 20 * * 1-5`, timezone `America/Sao_Paulo`. **Não roda sábado nem domingo.**
- Desligado por padrão. node-cron não recupera disparo perdido: se o serviço reiniciar às 20:00, o dev fica com a cópia anterior (registrado).

## Variáveis (Render → crm-backend)
| Variável | Obrigatória | Uso |
|---|---|---|
| `ESPELHO_SYNC_ENABLED` | sim | `true` liga o cron |
| `PROD_URI_READONLY` | sim | usuário **somente leitura** da produção (role `read`) |
| `ESPELHO_SYNC_TARGET_URI` | sim | cluster DEV; usuário com `readWrite` **só** em `fono_dev_espelho` |
| `ESPELHO_SYNC_TARGET_DB` | não | padrão `fono_dev_espelho` (nome com "prod" é recusado) |
| `ESPELHO_SYNC_TEST_PASSWORD` | sim | senha das contas de teste (mín. 8) |
| `ESPELHO_SYNC_PAUSED` | não | `true` pausa |
| `ESPELHO_SYNC_LIMITE_MB` | não | padrão 512 (M0). Aborta se o pico estimado passar de 90% |

## Garantias
- **Produção só leitura.** Destino recusado se estiver no host de `MONGO_URI`/`PROD_URI_READONLY`.
- **Troca segura:** copia para `__novo__*`, valida contagens e vínculos (órfãos não podem aumentar em relação à produção), só então substitui. Falha antes da troca → cópia anterior intacta. Falha na troca → `_espelho_controle.estado = 'inconsistente'`; a próxima execução refaz.
- **Sem simultâneas:** trava em `_espelho_controle {_id:'trava'}` (expira em 2h).
- **Pausa** (preserva testes em andamento): `npm run espelho:nuvem -- pausar "motivo"` / `retomar`.
- **Anonimização:** nome/telefone/CPF/RG/e-mail/endereço de pacientes, leads e equipe; texto de mensagens; tokens/segredos/certificados zerados. Ids, vínculos, tipos, valores, datas e status preservados.
- **Contas de teste** (senha = `ESPELHO_SYNC_TEST_PASSWORD`): `admin@espelho.local`, `terapeuta@espelho.local`, `secretaria@espelho.local`. Demais membros: `<colecao>.<id>@espelho.local`.
- **Nada dispara:** não copia `outboxes`/sessão do WhatsApp; cancela lembretes pendentes e follow-ups agendados; zera recuperação da Amanda. Quem usa o banco DEV deve rodar com `ENABLE_WORKERS=false`, `ENABLE_CRONS=false` e sem credenciais reais (WhatsApp, Sicoob, Meta/Google/TikTok) — o espelho local já faz isso (`scripts/espelho/environment.mjs`).

## Registro
- `_espelho_controle {_id:'controle'}`: `ultimaOk`, `ultimaFalha`, `ultimoErro`, `estado`, `pausado`.
- `_espelho_execucoes`: uma linha por execução (duração, medição, contagens, vínculos, avisos).
- `npm run espelho:nuvem -- status` mostra os dois.

## Comandos
`npm run espelho:nuvem -- medir | executar | pausar "motivo" | retomar | status` (lê `back/.env` ou `--env-file=`).
