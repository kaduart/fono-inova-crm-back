# 🚀 Staging Deploy Checklist - V2 System

**Data:** ___________  
**Responsável:** ___________  
**Versão:** 2.0.0

---

## ✅ Pre-Deploy (Antes de subir)

### 1. Código
- [ ] `git status` limpo (sem arquivos não commitados)
- [ ] Branch `main` ou `staging` atualizada
- [ ] Últimos testes E2E passaram localmente
- [ ] Nenhum `console.log` de debug no código

### 2. Banco de Dados
- [ ] Backup do MongoDB criado
- [ ] Migrations executados (se houver)
- [ ] Índices verificados (`email`, `appointmentId`, etc.)

### 3. Variáveis de Ambiente
- [ ] `.env.staging` configurado
- [ ] `MONGO_URI` aponta para DB de staging
- [ ] `REDIS_URL` configurado
- [ ] `JWT_SECRET` diferente de produção
- [ ] Feature flags V2 ativadas:
  - [ ] `FF_CREATE_V2=true`
  - [ ] `FF_COMPLETE_V2=true`
  - [ ] `FF_CANCEL_V2=true`

### 4. Infraestrutura
- [ ] Redis está rodando
- [ ] Workers estão configurados
- [ ] Porta 5000 (ou staging) disponível
- [ ] Logs configurados para arquivo/stdout

---

## 🚀 Deploy (Subindo o sistema)

### 5. Build & Start
```bash
# 1. Parar serviços antigos (se houver)
pm2 stop all  # ou kill node processes

# 2. Instalar dependências
npm ci --production

# 3. Verificar variáveis
node -e "console.log(process.env.NODE_ENV, process.env.MONGO_URI)"

# 4. Start com PM2 (recomendado)
pm2 start ecosystem.config.cjs --env staging

# 5. Verificar status
pm2 status
pm2 logs --lines 50
```

### 6. Health Check
- [ ] `GET /api/v2/health` retorna 200
- [ ] `GET /api/v2/health/detailed` mostra todos OK
- [ ] Conexão MongoDB: OK
- [ ] Conexão Redis: OK
- [ ] Workers ativos: OK

---

## 🧪 Post-Deploy (Validação)

### 7. Testes de Smoke (5 minutos)
Execute estes comandos rapidamente:

```bash
# Login
✅ curl -X POST http://localhost:5000/api/login \
  -d '{"email":"test@fonoinova.com","password":"test","role":"admin"}'

# Listar pacientes
✅ curl http://localhost:5000/api/v2/patients?page=1&limit=5 \
  -H "Authorization: Bearer $TOKEN"

# Listar agendamentos
✅ curl http://localhost:5000/api/v2/appointments \
  -H "Authorization: Bearer $TOKEN"
```

### 8. Testes E2E (15 minutos)
Execute o script de teste:

```bash
# Teste completo
node test-e2e-write.mjs
node test-e2e-financial.mjs

# Ou use a collection Bruno
cd collection/bruno
bru run --env staging
```

**Verificar:**
- [ ] Create Patient: 202 Accepted
- [ ] Create Appointment: 201 Created
- [ ] Complete Appointment: 200 + DTO V2
- [ ] Cancel Appointment: 202 ou 409 (blocked)
- [ ] Package Create: Validações por tipo
- [ ] Balance: Débito/Pagamento funcionando

### 9. Validação do Frontend
- [ ] Login funciona sem erro
- [ ] Lista de agendamentos carrega
- [ ] Criar agendamento: sucesso
- [ ] Completar sessão: atualiza estado
- [ ] DTO V2 mostrado no DevTools (`meta.version: "v2"`)

---

## 🔍 Validação de Segurança

### 10. Autenticação
- [ ] Sem token = 401 Unauthorized
- [ ] Token inválido = 401
- [ ] Token expirado = 401
- [ ] Role sem permissão = 403

### 11. Validação de Dados
- [ ] Payload inválido = 400 + mensagem clara
- [ ] Campos obrigatórios faltando = 400
- [ ] ID inexistente = 404
- [ ] Conflito de estado = 409

---

## 📊 Monitoramento

### 12. Logs (obrigatório)
```bash
# Ver erros nos últimos 5 minutos
tail -f logs/server.log | grep -E "ERROR|WARN|❌"

# Ver throughput
pm2 monit
```

### 13. Métricas
- [ ] Tempo de resposta < 500ms (p95)
- [ ] Taxa de erro < 1%
- [ ] Conexões MongoDB < 20
- [ ] Memory usage < 500MB

---

## 🔄 Rollback (se necessário)

### 14. Plano de Rollback
```bash
# 1. Parar serviço atual
pm2 stop crm-api

# 2. Restaurar backup do DB (se necessário)
mongorestore --uri="$MONGO_URI" --archive=backup-$(date +%Y%m%d).gz

# 3. Checkout para versão anterior
git checkout v1.x.x

# 4. Restart
pm2 start ecosystem.config.cjs --env staging
```

---

## ✅ Sign-off Final

| Item | Status | Observação |
|------|--------|------------|
| Código commitado | ⬜ | |
| DB backup feito | ⬜ | |
| Deploy executado | ⬜ | |
| Health check OK | ⬜ | |
| Smoke tests OK | ⬜ | |
| E2E tests OK | ⬜ | |
| Frontend validado | ⬜ | |
| Logs limpos | ⬜ | |
| Rollback testado | ⬜ | |

**Aprovado para Produção?** ⬜ SIM / ⬜ NÃO

**Assinatura:** ___________  
**Data:** ___________

---

## 🚨 Contingência

Se algo quebrar:

1. **Não entra em pânico**
2. Verifique logs: `tail -100 logs/server.log`
3. Teste health: `curl /api/v2/health`
4. Se necessário: execute rollback
5. Comunique o time no Slack: `#incidents`

**Contatos de Emergência:**
- Tech Lead: _________
- DevOps: _________
- On-call: _________

---

💀 **Lembrete:** Staging é espelho de produção. Se quebrar aqui, não suba para produção!