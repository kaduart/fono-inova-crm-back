# Inventário Técnico — Merge `whatsapp-rebuild` → `main`

**Gerado em:** 25/07/2026  
**Branch origem:** `whatsapp-rebuild`  
**Branch destino:** `main`  
**Baseline funcional:** `a7b8bdd7`

---

## Resumo

Existem **34 entradas de diff** entre `main` e `whatsapp-rebuild`. A grande maioria das diferenças não é do WhatsApp — são funcionalidades normais do `main` que foram desenvolvidas **após** o baseline `a7b8bdd7` e que **não existem** no `whatsapp-rebuild`.

Isso significa que **não podemos fazer um merge automático** nem um reset simples. É preciso um merge cirúrgico, mantendo as funcionalidades do `main` e aplicando apenas as melhorias validadas do WhatsApp.

---

## Categorias

### 1. WhatsApp Web — deve ser substituído pela versão do `whatsapp-rebuild`

| Arquivo | Ação | Motivo |
|---------|------|--------|
| `services/whatsappWebJsService.js` | **Substituir** pelo do `whatsapp-rebuild` | Remove mitigações problemáticas; mantém código limpo e funcional |
| `models/WhatsAppWebState.js` | **Revisar** | `whatsapp-rebuild` removeu `pageFrozenAt`; `main` adicionou campos de storage/diagnóstico |
| `routes/health.js` | **Mesclar** | Manter endpoints existentes do `main` e adicionar `GET /api/health/whatsapp` simples |
| `workers/entrypoints/whatsapp-child.js` | **Revisar** | Possui comunicação com processo pai; `whatsapp-rebuild` pode ter versão mais enxuta |
| `workers/startWorkers.js` | **Revisar** | `main` pode ter alterações para health/bull board que não devem ser perdidas |
| `infrastructure/observability/whatsappPipelineGuard.js` | **Revisar** | `main` adicionou alertas de atraso WhatsApp; `whatsapp-rebuild` pode ter simplificado |
| `package.json` | **Alterar versão da lib** | Trocar `pedroslopez#1780711a` → `wwebjs/whatsapp-web.js#main` |
| `package-lock.json` | **Regenerar** | Refletir a mudança da dependência |

### 2. Funcionalidades do `main` que NÃO podem ser perdidas

| Arquivo | Nota |
|---------|------|
| `controllers/insuranceV2Controller.js` | Nota fiscal / guias |
| `models/InsuranceBatch.js` | Nota fiscal / guias |
| `models/InsuranceCommunication.js` | Nota fiscal / guias |
| `routes/adminSystem.js` | Admin / bull board |
| `routes/communication.routes.js` | Comunicações |
| `routes/financialDashboard.v2.js` | Dashboard financeiro |
| `server.js` | Registro de rotas, middleware |
| `services/appointment/commands/cancelAppointmentCommand.js` | Cancelamento de agendamento |
| `services/communication/CommunicationRequestService.js` | Comunicações |
| `services/completeSession/handlers/convenioHandler.js` | Convênios |
| `services/insuranceBatchGuideAdapter.js` | Nota fiscal / guias |
| `services/insuranceBatchService.js` | Nota fiscal / guias |
| `tests/cancelAppointmentCommand.test.js` | Testes de cancelamento |

**Ação:** manter a versão do `main`.

### 3. Scripts e utilitários

| Arquivo | Ação |
|---------|------|
| `scripts/audit-guias-nao-encerradas.mjs` | Manter do `main` |
| `scripts/audits/lib/classifica-payments-convenio.js` | Manter do `main` |
| `scripts/backups-migration/appointment-*.json` | Manter do `main` (dados) |
| `logs-archive/documento-analise-particular.txt` | Manter do `main` |
| `logs-archive/documento-analise.txt` | Manter do `main` |

### 4. Documentação

| Arquivo | Ação |
|---------|------|
| `docs/ARQUITETURA_EVENT_DRIVEN.md` | Manter do `main` |
| `docs/DOMAIN_INVARIANTS.md` | Manter do `main` |
| `docs/RCA_WHATSAPP_LID_2026-07-24.md` | **Deletar** (obsoleto) |
| `docs/WHATSAPP_IDB_QUOTA_RCA.md` | **Deletar** (obsoleto) |
| `docs/RCA_WHATSAPP_REBUILD_2026-07-25.md` | **Manter** (RCA final) |
| `docs/WHATSAPP_REBUILD_INVENTORY.md` | **Manter** (este arquivo) |

### 5. Outros

| Arquivo | Ação |
|---------|------|
| `.gitignore` | Revisar e manter do `main` se possível |

---

## Estratégia de merge recomendada

1. **Criar branch a partir do `main`** (já existe: `whatsapp-main-cleanup`).
2. **Substituir `services/whatsappWebJsService.js`** inteiramente pela versão do `whatsapp-rebuild`.
3. **Mesclar `routes/health.js`:** manter todos os endpoints do `main` e adicionar `GET /api/health/whatsapp`.
4. **Ajustar `models/WhatsAppWebState.js`:** remover `pageFrozenAt`; manter campos úteis como `sessionSizeMB`/`diskUsagePercent` se forem usados.
5. **Revisar `workers/entrypoints/whatsapp-child.js` e `workers/startWorkers.js`:** manter comunicação com parent e health, descartar lógica de frozen.
6. **Revisar `infrastructure/observability/whatsappPipelineGuard.js`:** manter alertas de atraso, descartar o que depende de `pageFrozenAt`.
7. **Alterar `package.json`** para `wwebjs/whatsapp-web.js#main` e regenerar `package-lock.json`.
8. **Deletar RCAs obsoletas** e manter as novas.
9. **Não tocar** nos arquivos de nota fiscal, cancelamento, dashboard, etc.
10. **Testar** deploy em staging antes de mergear no `main`.

---

## Riscos

| Risco | Mitigação |
|-------|-----------|
| Perder funcionalidades do `main` | Merge manual guiado por este inventário |
| Reintroduzir mitigações problemáticas | Não aceitar nenhuma alteração de `main` em `whatsappWebJsService.js` |
| Incompatibilidade da nova versão da lib | Testar deploy em staging antes de prod |
| `package-lock.json` inconsistente | Regenerar com `npm install` após alterar `package.json` |

---

## Próximos passos

1. Executar o merge cirúrgico no `whatsapp-main-cleanup`.
2. Rodar `node --check` nos arquivos alterados.
3. Fazer push e abrir PR/deploy em staging.
4. Validar envio de mensagens por algumas horas.
5. Só então mergear no `main`.
