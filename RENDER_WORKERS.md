# 🚀 Workers no Render.com

## Como funciona?

O `render.yaml` já está configurado com **2 serviços Worker**:

```yaml
1. crm-backend (Web Service)    → Roda: node server.js
2. crm-worker   (Worker)        → Roda: node workers/startWorkers.js
3. crm-watchdog (Worker)        → Opcional, para recuperação
```

## O que cada um faz?

| Serviço | Tipo | Função |
|---------|------|--------|
| `crm-backend` | Web | API HTTP (login, agendamentos, etc) |
| `crm-worker` | Worker | Processa filas (complete, cancel, payment, etc) |
| `crm-watchdog` | Worker | Recupera jobs travados (opcional) |

## Deploy no Render

### 1. O Render já vai criar automaticamente:
- ✅ Web Service: `crm-backend`
- ✅ Worker: `crm-worker` 
- ✅ Worker: `crm-watchdog` (se quiser)

### 2. Variáveis de ambiente necessárias:
```bash
MONGODB_URI=mongodb+srv://usuario:senha@cluster.mongodb.net/crm
REDIS_URL=redis://redis-cloud-url:6379
JWT_SECRET=seu-jwt-secret
NODE_ENV=production
```

### 3. Logs para verificar se funcionou:

**No worker `crm-worker`, você deve ver:**
```
🚀 Iniciando Workers no Render...
🟢 Conectando ao MongoDB...
✅ MongoDB conectado
⚙️  Iniciando todos os workers...
[Workers] ✅ CompleteOrchestratorWorker iniciado
...
🎉 Todos os workers iniciados com sucesso!
```

**E quando processar um complete:**
```
[WORKER] Job 123 recebido: APPOINTMENT_COMPLETE_REQUESTED
[SUCCESS] 📡 Socket emitido: appointmentUpdated ABC123
```

## ⚠️ Se o worker não estiver rodando:

1. Vá no Dashboard do Render → Services → `crm-worker`
2. Clique em "Logs" para ver o erro
3. Ou clique em "Restart" para reiniciar

## 🧪 Teste em produção:

```bash
# Complete um agendamento via API
curl -X PATCH https://seu-app.onrender.com/api/v2/appointments/ID/complete \
  -H "Authorization: Bearer TOKEN"

# Verifique os logs do worker no Render Dashboard
# Deve aparecer: "[WORKER] Job X recebido" e "[SUCCESS] Appointment Y completado"
```

## 🔥 Importante:

- O **Web Service** (`server.js`) inicia workers dentro dele também
- Mas o **Worker separado** (`crm-worker`) garante que os jobs sejam processados mesmo se o web service reiniciar
- Em produção, os dois funcionam juntos (redundância)
