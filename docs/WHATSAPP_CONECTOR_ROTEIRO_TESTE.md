# Roteiro de teste do conector com número exclusivo

**NÃO EXECUTAR SEM AUTORIZAÇÃO EXPLÍCITA DO KADU.** Este roteiro conecta um WhatsApp de verdade. Ele nunca usa o número da clínica nem a sessão da clínica, e nunca aponta para o banco ou o Redis de produção.

Objetivo: cobrir a coluna "Sessão real" da matriz (seção 14 de `WHATSAPP_CONECTOR_EXTERNO.md`), ou seja, QR, ready, reconexão, reinício, mensagens, ctwa e enquetes.

## 1. Pré-requisitos

| Item | Detalhe |
|---|---|
| Número de teste | Chip **exclusivo**, nunca usado pela clínica, num celular próprio para o teste ("celular T"). |
| Celular de paciente | Outro WhatsApp ("celular P"), para mandar e receber mensagens. |
| Anúncio para o ctwa | Um anúncio "clique para WhatsApp" apontando para o número de teste, com orçamento mínimo. Se não houver, a etapa 8 fica pendente. |
| Onde roda o conector | Uma máquina com 2,5–3 GB livres e acesso a web.whatsapp.com (por exemplo, o PC do Kadu). Não é preciso host novo para o teste. |
| CRM | CRM local com **banco vazio** só de teste (um banco novo no Mongo local, Redis local limpo), `ENABLE_CRONS=false`, crm-worker em `WHATSAPP_CONNECTOR_MODE=external`. **Não usar o espelho**: ele tem os telefones reais dos pacientes, e o código não tem lista de números permitidos, então qualquer lembrete ou cron poderia mandar mensagem para paciente de verdade. No banco de teste, cadastrar só o paciente fictício com o telefone do celular P. |
| Segredo | Um `WA_CONNECTOR_SECRET` novo, só para o teste (≥32 caracteres), diferente do de produção. |
| Pasta da sessão | Uma pasta nova, por exemplo `~/wa-teste/data`. Apagar no fim (etapa 12). |

## 2. Preparação

1. No repositório, entrar em `whatsapp-connector`, rodar `npm ci` e depois `npm test` (esperado: 26 passando).
2. Envs do conector:
   - `WA_CONNECTOR_SECRET=<segredo de teste>`
   - `CRM_EVENTS_URL=<API local de teste>/api/whatsapp-connector/events` (com `WA_ALLOW_HTTP_EVENTS=true` se a API for http local)
   - `WA_CONNECTOR_DATA_DIR=~/wa-teste/data`
   - `WA_CONNECTOR_ID=teste`
   - `CHROME_PATH=<Chrome 157.0.8103.38>`
3. Envs do crm-worker **local de teste**: `WHATSAPP_CONNECTOR_MODE=external`, `WA_CONNECTOR_URL=http://127.0.0.1:8787` e o mesmo segredo, que também vai na API local de teste. Antes de ligar, conferir que a fila `whatsapp-send` no Redis local está vazia.

Evidência de cada etapa: o print do painel e o trecho do log do conector (`[Engine]`, `[Conector]`, linha de memória a cada 60 s).

## 3. Etapas

| # | Etapa | Como | Resultado esperado |
|---|---|---|---|
| 1 | Subida e trava | `npm start` | Log com a porta (🟢). A pasta `data` fica 0700 e existe `.connector-lock.json`. Um segundo `npm start` na mesma pasta **recusa** ("sessão em uso"). |
| 2 | QR | Abrir o painel do CRM local | Status `qr` com imagem. O QR troca sozinho a cada ~20 s. |
| 3 | Ready | Escanear com o **celular T** | Status `ready`. Linha de memória registra Node, Chrome RSS/PSS e cgroup. Anotar o número. |
| 4 | Mensagem recebida | P manda "oi" para T | Evento `message.inbound` chega no CRM local, sem duplicar. Telefone resolvido (inclusive se vier como @lid). |
| 5 | Envio da fila | Agendar um lembrete no CRM local para o telefone de P | P recebe **uma** mensagem. `outbound_deliveries` fica `sent` com a chave `wweb:send:<job>`. Repetir o job **não** reenvia. |
| 6 | Enquete | Lembrete com enquete de presença | P recebe texto + enquete. P vota "Confirmar presença ✅". Evento `poll.vote` chega e a presença é registrada. |
| 7 | Mensagem da clínica | Responder P pelo celular T | Evento `message.outbound` chega e a data da conversa atualiza. |
| 8 | ctwa (anúncio) | Do celular P, tocar no anúncio e mandar a mensagem pronta | Log `📣 ctwaContext recebido (conector)` com clid. O lead do CRM local ganha a origem do anúncio. **Conferir se os bytes do ctwa chegam** (em produção chegavam vazios antes do PR #81). |
| 9 | Reconectar | Botão Reconectar no painel | Volta a `ready` **sem** novo QR. |
| 10 | Reinício do processo | `Ctrl+C` e `npm start` de novo | Encerra limpo (trava liberada) e volta `ready` sem QR. Mensagem que P mandar durante a parada chega pelo catch-up, sem duplicar. |
| 11 | Queda do Chrome | Matar o processo do Chrome (`kill` no pid do browser) | Status `restarting`, depois `ready` sozinho, sem QR. Um envio no meio da queda vira **incerto** e não é reenviado. |
| 12 | Conflito | Abrir o WhatsApp Web do número T num navegador comum | Conector vai a `conflict` e **não** retoma sozinho. Fechar o navegador e apertar Reconectar: volta `ready`. |
| 13 | Conector fora do ar | Parar o conector com o worker local ligado | Painel mostra "conector sem resposta" em ~15 s. Envio da fila **não** sai e volta para a fila. Nenhum Chrome abre no worker. |
| 14 | Memória sob uso | Deixar ligado 1 h com as etapas 4–7 repetidas | Anotar pico e regime de Chrome RSS, PSS e cgroup. Isto substitui a estimativa do host. |
| 15 | Encerramento | Parar o conector. No celular T: Aparelhos conectados → remover. Apagar `~/wa-teste/data`. | Sem sessão de teste restante em lugar nenhum. |

## 4. O que fica fora deste roteiro

- Sessão da clínica e transferência real (seção 10 do documento principal): só depois de host aprovado e com nova autorização.
- Produção (Mongo, Redis, Render): nenhuma etapa toca.
- Varredura profunda de convênio: precisa de histórico de conversas. Dá para testar no número T depois de algumas conversas com a palavra do convênio, como etapa extra opcional.

## 5. Teste de ARM64 (Oracle Ampere A1), sem parear

**Também não executar sem autorização.** Este teste não escaneia QR, não usa número nenhum e não toca na sessão da clínica. Critério para seguir com a Oracle: o conector real sobe, abre o WhatsApp Web até a tela de QR e passa por ciclos de reinício sem deixar processo órfão.

**O que a análise do código já mostrou (19/11):**
- `whatsapp-web.js` 1.34.7 → `puppeteer` 24.38.0 → `@puppeteer/browsers` 2.13.0 (lockfile do #88). Em Linux ARM64, `@puppeteer/browsers` mapeia `LINUX_ARM` para a pasta `linux64` e baixa o **Chrome x86-64**. O `npm ci` passa, mas esse binário não executa em ARM.
- Por isso, no ARM é obrigatório: `PUPPETEER_SKIP_DOWNLOAD=true` no `npm ci` e um Chromium ARM64 da distribuição (Debian 12: pacote `chromium`) apontado por `CHROME_PATH`. O conector já lê `CHROME_PATH`/`PUPPETEER_EXECUTABLE_PATH` (`src/index.js`).
- O resto do lockfile é JavaScript puro (sem binário nativo). Node 20+ tem build oficial ARM64.
- Risco: a versão do Chromium da distribuição não é a 157 fixada em produção (por causa do SIGTRAP de 09/11). Anotar a versão usada.
- Não existe imagem Docker do conector. O teste roda direto na VM (ou em uma imagem `node:20-bookworm` com `apt install chromium`).

**Passos (VM ARM64 de teste, sem dados de produção):**
1. `uname -m` = `aarch64`. Instalar Node 20 e `chromium`. Anotar `chromium --version`.
2. Em `whatsapp-connector`: `PUPPETEER_SKIP_DOWNLOAD=true npm ci`, depois `npm test` (esperado: 26 passando).
3. Subir com `CHROME_PATH=/usr/bin/chromium`, segredo de teste, pasta nova de dados e `CRM_EVENTS_URL` apontando para um receptor falso local. Esperado: status `qr` com imagem (o QR **não** é escaneado).
4. Ciclos: 10 vezes `Ctrl+C` → `npm start`. Depois de cada parada, `pgrep -fa chromium` precisa voltar vazio. Matar o Chrome com `kill -9` 3 vezes: o conector volta a `qr` sozinho e não sobra processo.
5. Memória: anotar a linha de memória do conector (60 s) e `free -m` no pico. Isso mede só a tela de QR. O consumo com sessão real fica para o roteiro principal.
6. Encerramento: parar, apagar a pasta de dados e a VM de teste, se ela foi criada só para isso.
