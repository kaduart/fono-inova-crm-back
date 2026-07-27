# RCA — Incidente WhatsApp Web / IndexedDB Corrompido

**Data do incidente:** 25/07/2026
**Serviço afetado:** Worker WhatsApp Web (`whatsapp-core`)
**Biblioteca:** `whatsapp-web.js` 1.34.7
**Ambiente:** Render + Persistent Disk + Chrome Puppeteer

---

## Resumo executivo

O serviço de WhatsApp Web apresentou falhas intermitentes ao acessar chats e enviar mensagens.

Após investigação, foi identificado que o problema não estava relacionado ao código de envio, Redis, fila BullMQ ou autenticação do WhatsApp.

A causa raiz foi uma inconsistência no armazenamento persistente do Chrome (IndexedDB) utilizado pelo WhatsApp Web dentro da sessão salva pelo `whatsapp-web.js`.

A sessão antiga estava corrompida, impedindo operações internas do WhatsApp Web.

A remoção da sessão e nova autenticação resolveram definitivamente o problema.

---

# Sintomas observados

Os principais erros registrados foram:

```
DataError: Failed to execute 'get' on 'IDBObjectStore':
No key or key range specified
```

e:

```
QuotaExceededError
```

Impactos:

* `getChats()` falhando
* `getChatById()` inconsistente
* `sendMessage()` apresentando comportamento inesperado
* Diagnósticos do WhatsApp Web retornando erros internos

---

# Investigação realizada

Foram validados:

## Infraestrutura

✅ Chrome instalado corretamente
✅ Puppeteer funcionando
✅ Node.js estável
✅ Redis conectado
✅ MongoDB conectado
✅ Memória do processo saudável

Memória observada:

```
RSS: ~150 MB
Heap: ~55 MB
```

Sem sinais de vazamento.

---

## Autenticação

A autenticação estava funcionando:

```
authenticated — celular escaneou o QR
```

Posteriormente:

```
getState() retornou CONNECTED
```

Portanto o problema não era sessão expirada ou QR inválido.

---

# Causa raiz

A sessão persistida em:

```
/var/data/wwebjs_auth/session
```

continha dados internos do Chrome/WhatsApp Web com problemas no IndexedDB.

O WhatsApp Web utiliza IndexedDB para armazenar dados locais, incluindo:

* mensagens
* contatos
* estados internos
* cache operacional

Quando esse armazenamento fica inconsistente, o WhatsApp Web continua abrindo, porém algumas operações internas quebram.

---

# Correção aplicada

## 1. Reset controlado da sessão

Foi realizada limpeza da sessão:

```
/var/data/wwebjs_auth/session
```

Após isso:

* novo QR Code gerado
* autenticação refeita
* sessão reconstruída corretamente

Resultado:

```
WhatsApp READY
Envios funcionando
```

---

## 2. Ajuste do FORCE_CLEAN

Antes:

* comportamento confuso
* necessidade de limpeza manual

Depois:

```
WHATSAPP_FORCE_CLEAN_SESSION=true
```

passa a remover corretamente a sessão problemática.

Operação normal:

```
WHATSAPP_FORCE_CLEAN_SESSION=false
```

mantém a sessão persistente.

---

## 3. Isolamento em processo filho

Mantido o modelo:

```
Parent Process
      |
      |
 Child WhatsApp Process
      |
      |
 Chrome + whatsapp-web.js
```

Benefícios:

* falha do Chrome não derruba API principal
* shutdown controlado
* restart isolado

---

## 4. Monitoramento preventivo

Adicionado monitoramento de armazenamento:

Verificação:

* tamanho da sessão WhatsApp
* espaço disponível no disco
* percentual utilizado

Alertas:

* sessão crescendo excessivamente
* disco acima do limite definido

---

## 5. Endpoint de saúde

Criado:

```
GET /api/health/whatsapp
```

Retorna:

* status do WhatsApp
* autenticação
* ready state
* tamanho da sessão
* uso do disco
* alertas de storage
* estado da fila

Exemplo:

```json
{
  "status": "healthy",
  "whatsapp": {
    "status": "ready",
    "ready": true,
    "authenticated": true,
    "sessionSizeMB": 118.5,
    "diskUsagePercent": 12,
    "storageAlert": false
  },
  "queue": {
    "waiting": 0,
    "active": 0,
    "failed": 0
  }
}
```

---

# Melhorias adicionais entregues

## Atualização whatsapp-web.js

Biblioteca fixada em versão oficial:

```
pedroslopez/whatsapp-web.js
```

Objetivo:

* evitar comportamento imprevisível vindo de branches instáveis
* maior previsibilidade de deploy

---

## Resolução LID → PN

Implementada resolução de identificadores:

```
LID
 ↓
Phone Number (PN)
```

Antes do envio.

Benefício:

* maior compatibilidade com novos formatos internos do WhatsApp.

---

## Filtro de ruído nos logs

Removidos falsos positivos:

* `IDBObjectStore`
* `DataError`
* `QuotaExceededError`
* telemetria CORS:

```
dit.whatsapp.net/deidentified_telemetry
```

Esses erros eram internos do WhatsApp Web e não representavam falha da aplicação.

---

# Estado final

## WhatsApp Web

✅ Conectado
✅ Autenticação persistente
✅ Envios funcionando
✅ Sessão salva corretamente
✅ Child process estável

## Observabilidade

✅ Health check criado
✅ Storage monitorado
✅ RCA documentado
✅ Logs limpos

## Histórico de commits

| Commit     | Entrega                                               |
| ---------- | ----------------------------------------------------- |
| `ac2a70d4` | Monitoramento de storage + RCA + correção FORCE_CLEAN |
| `492eaf1b` | Filtro de ruído nos logs do browser                   |
| `869e319c` | Endpoint `/api/health/whatsapp`                       |

---

# Conclusão

O incidente foi causado por corrupção/inconsistência do IndexedDB da sessão persistente do Chrome utilizada pelo WhatsApp Web.

A solução aplicada não foi apenas restaurativa: foram adicionados mecanismos de prevenção, monitoramento e diagnóstico para evitar repetição do problema e reduzir tempo de investigação em futuros incidentes.
