# RCA — Falha no envio de mensagens WhatsApp (LID + PN divergente)

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

## Correção inicial

A primeira correção tentou resolver o LID para o Phone Number (PN) via `client.getContactLidAndPhone()` e usar o PN no `sendMessage()`.

No entanto, durante a validação descobriu-se que o PN retornado pelo WhatsApp pode ser **divergente** do número original:

```text
Esperado: 5561981694922@c.us
Retornado: 556181694922@c.us
                   ^
                   falta o dígito 9
```

Enviar para um PN inconsistente também falhava.

---

## Correção final

O serviço agora tenta enviar em **múltiplas estratégias**, na ordem:

1. **Usar o id retornado por `getNumberId()`** (pode ser LID ou `@c.us`)
2. **Resolver PN via `getContactLidAndPhone()`**, mas só usar se os dígitos baterem com o número original
3. **Usar o número original no formato `@c.us`** como fallback

A primeira estratégia que funcionar vence.

```text
getNumberId()
  ↓
 tentativa 1: sendMessage(@lid)
  ↓ se falhar
getContactLidAndPhone()
  ↓
valida PN contra número original
  ↓ se confiável
 tentativa 2: sendMessage(PN @c.us)
  ↓ se falhar ou divergente
 tentativa 3: sendMessage(numeroOriginal @c.us)
```

Código em `back/services/whatsappWebJsService.js`:

```javascript
const candidates = [numberId._serialized];

if (numberId._serialized.endsWith('@lid')) {
  const lidAndPhone = await client.getContactLidAndPhone([numberId._serialized]);
  const pn = lidAndPhone?.[0]?.pn;
  if (pn) {
    const pnDigits = pn.replace(/\D/g, '');
    if (pnDigits === clean) candidates.push(pn);
  }
}

const originalWid = `${clean}@c.us`;
if (!candidates.includes(originalWid)) candidates.push(originalWid);

for (const chatId of candidates) {
  try {
    const result = await client.sendMessage(chatId, message);
    return { success: true, messageId: result?.id?._serialized, chatId };
  } catch (sendErr) {
    console.log(`sendMessage para ${chatId} falhou:`, sendErr?.message);
  }
}
```

---

## Validação

- Worker `crm-worker` redeployado no Render.
- Sessão WhatsApp autenticada e pronta.
- Job 502 processado com sucesso usando LID diretamente:

```text
[WhatsAppWeb] ✅ Enviado para 5561981694922 — ID: true_257294377951469@lid_3EB0B9A54CEDC73D3FFA77
[CHILD WORKER] ✅ Job 502 — enviado com sucesso
```

---

## Notas

- A dependência `whatsapp-web.js` também foi atualizada para um commit do fork que corrige a mudança interna do WhatsApp de `_serialized` para `$1` em objetos `Wid`.
- O formato do telefone (`61981694922` → `5561981694922`) não era o problema; a normalização estava correta.
- O LID continua aparecendo no ID final da mensagem (`true_257294377951469@lid_...`), o que é esperado.
- O WhatsApp pode retornar PN divergente do número original; por isso o PN deve ser validado antes de ser usado como destino.

---

## Commits

```text
fix(whatsapp): resolve LID para PN antes do envio
fix(whatsapp): valida PN e tenta LID, PN e @c.us em ordem
docs: adiciona RCA do incidente WhatsApp LID
```
