# RCA — Falha no envio de mensagens WhatsApp (LID)

**Data:** 2026-07-24  
**Serviço afetado:** `crm-worker` (WhatsApp child process)  
**Arquivos alterados:** `back/services/whatsappWebJsService.js`  

---

## Sintoma

Mensagens enfileiradas na fila `whatsapp-send` falhavam no envio com erro minificado:

```text
[WhatsAppWeb] ❌ Erro ao enviar para 5561981694922: r
```

O pipeline funcionava ponta a ponta: API → fila BullMQ → `whatsapp-child.js` → `whatsappWebJsService.sendMessage()` → `client.sendMessage()`.
A falha ocorria exclusivamente dentro da chamada `client.sendMessage()` do `whatsapp-web.js`.

---

## Causa raiz

O WhatsApp Web passou a retornar identificadores **LID (Linked Identity)** para determinados contatos, em vez do tradicional formato `@c.us` baseado no número de telefone.

Retorno esperado antes:

```text
5561981694922@c.us
```

Retorno observado:

```json
{
  "server": "lid",
  "user": "257294377951469",
  "_serialized": "257294377951469@lid"
}
```

O serviço utilizava diretamente o resultado de `client.getNumberId()` como destino de `client.sendMessage()`. Quando o resultado era um LID, o envio falhava internamente no browser, retornando apenas a exceção minificada `r`.

```text
telefone
  ↓
getNumberId()
  ↓
LID (257294377951469@lid)
  ↓
sendMessage(@lid)
  ↓
erro "r"
```

---

## Correção

Antes de chamar `sendMessage`, o serviço agora detecta quando o `getNumberId()` retorna um identificador `@lid` e resolve o **Phone Number (PN)** correspondente via `client.getContactLidAndPhone()`.

```text
getNumberId()
  ↓
detecta @lid
  ↓
getContactLidAndPhone()
  ↓
extrai pn (5561981694922@c.us)
  ↓
sendMessage(@c.us)
  ↓
✅ mensagem enviada
```

Código em `back/services/whatsappWebJsService.js`:

```javascript
let chatId = numberId._serialized;
if (chatId.endsWith('@lid')) {
  const lidAndPhone = await client.getContactLidAndPhone([chatId]);
  const pn = lidAndPhone?.[0]?.pn;
  if (pn) chatId = pn;
}

const result = await client.sendMessage(chatId, message);
```

---

## Validação

- Worker `crm-worker` redeployado no Render.
- Sessão WhatsApp autenticada e pronta.
- Job 502 processado com sucesso:

```text
[WhatsAppWeb] ✅ Enviado para 5561981694922 — ID: true_257294377951469@lid_3EB0B9A54CEDC73D3FFA77
[CHILD WORKER] ✅ Job 502 — enviado com sucesso
```

---

## Notas

- A dependência `whatsapp-web.js` também foi atualizada para um commit do fork que corrige a mudança interna do WhatsApp de `_serialized` para `$1` em objetos `Wid`.
- O formato do telefone (`61981694922` → `5561981694922`) não era o problema; a normalização estava correta.
- O LID continua aparecendo no ID final da mensagem (`true_257294377951469@lid_...`), o que é esperado; o envio, no entanto, deve ser feito usando o PN resolvido.

---

## Commit

```text
fix(whatsapp): resolve LID para PN antes do envio
```
