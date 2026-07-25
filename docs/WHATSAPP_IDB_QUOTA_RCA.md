# RCA — WhatsApp Web: IndexedDB QuotaExceededError / DataError

**Data:** 2026-07-25  
**Serviço afetado:** `crm-worker` → WhatsApp Web.js → envio de mensagens  
**Status:** Resolvido ✅

---

## 1. Sintomas

- Mensagens pararam de ser enviadas pelo worker.
- Log mostrava erro minificado: `r: r` vindo do Puppeteer/`page.evaluate()`.
- Worker, Redis, Chrome, autenticação e evento `ready` funcionavam normalmente.
- Contato era resolvido corretamente (`getContactById` OK).
- `getChats()`, `getChatById()` e `sendMessage()` falhavam.

## 2. Erro real (depois de instrumentar)

```text
DataError: Failed to execute 'get' on 'IDBObjectStore': No key or key range specified.
storage-error: idb failed to do Operation: bulkGet on Table: message

AbortError: QuotaExceededError
```

Origem: JavaScript do WhatsApp Web dentro do Chromium, ao acessar o IndexedDB local.

## 3. Causa raiz

A sessão persistida do Chrome em `/var/data/wwebjs_auth/session` ficou com o **IndexedDB corrompido/lotado**. Como o disco persistente do `crm-worker` estava configurado com **1 GB**, o WhatsApp Web passou a rejeitar operações de leitura/escrita no store de mensagens.

Isso aconteceu mesmo com ~958 MB livres no momento da investigação, ou seja: não era falta de espaço absoluto no disco, mas sim estado corrompido/estourado do perfil do Chrome.

## 4. Por que demorou para diagnosticar

1. O Puppeteer estava mascarando a exceção real como `r` (erro minificado).
2. O `whatsapp-web.js` encapsula o erro, então só via `Client.sendMessage` falhando.
3. A variável `WHATSAPP_FORCE_CLEAN_SESSION` originalmente exigia `WHATSAPP_ALLOW_CLEAN='true'` também, então a limpeza manual não funcionava com apenas uma variável.
4. O código de limpeza não apagava a pasta `session/` onde fica o IndexedDB.

## 5. Solução imediata

1. Corrigir o parsing de `WHATSAPP_FORCE_CLEAN_SESSION` para aceitar `true/1/yes` sozinho.
2. Incluir `session/` na lista de pastas removidas pela limpeza forçada.
3. Ativar `WHATSAPP_FORCE_CLEAN_SESSION=true` no dashboard do Render.
4. Fazer deploy.
5. Escanear o novo QR code.
6. Após reconectar e confirmar envio, voltar `WHATSAPP_FORCE_CLEAN_SESSION=false`.

## 6. Prevenção implementada

- **Disco aumentado** no `render.yaml` de `1 GB` para `5 GB`.
- **Monitoramento de storage** no startup do WhatsApp child (`du/df` de `/var/data/wwebjs_auth`).
- **Ajuste do FORCE_CLEAN** para funcionar com apenas uma variável de ambiente.

## 7. Próximas melhorias recomendadas

- Rotina periódica de limpeza de cache do Chrome (sem apagar autenticação).
- Alerta automático quando a sessão passar de ~500 MB ou o disco passar de 80%.
- Endpoint de health retornando tamanho da sessão.

## 8. Variáveis de ambiente

| Variável | Valor padrão | Quando usar |
|---|---|---|
| `WHATSAPP_FORCE_CLEAN_SESSION` | `false` | `true` só para forçar novo QR; depois voltar para `false`. |

## 9. Referências

- `back/services/whatsappWebJsService.js` — inicialização, limpeza e envio.
- `render.yaml` — configuração do disco persistente.
