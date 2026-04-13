# 🚀 DEPLOY CHECKLIST FINAL - V2 Production

> Última validação antes de liberar para clientes

---

## ⚡ PRÉ-DEPLOY (5 min)

### 1. Ambiente
- [ ] Node.js versão compatível (`node -v`)
- [ ] MongoDB conectado e saudável
- [ ] Redis ativo (para workers)
- [ ] Variáveis de ambiente configuradas

### 2. Código
- [ ] Branch `main` atualizada
- [ ] Commit com mensagem clara: `feat: LOCK V2 MODE - billing engine stable`
- [ ] Nenhum `console.log` de debug crítico

---

## 🧪 TESTES OBRIGATÓRIOS (10 min)

### 3. Unit/Contract Tests
```bash
npm run test:contract
```
- [ ] Todos passaram ✅

### 4. E2E Manual Rápido
```bash
# 1 particular
04-packages/particular-flow/1-Create → 09-complete-flow/2-Complete
→ Verificar: balanceAmount = 150 ✅

# 1 convênio  
04-packages/convenio-flow/1-Create → 09-complete-flow/1-Complete
→ Verificar: balanceAmount = 0 ✅

# 1 cancel
08-cancel-flow/1-Cancel → 2-Check
→ Verificar: processing → canceled ✅
```

---

## 🔍 VERIFICAÇÃO DE LOGS (3 min)

### 5. Server Logs
```bash
npm run dev
```
Procurar:
```
✅ [complete] 🔒 LOCK V2
✅ [CompleteSessionV2] ✅ Transação commitada
❌ NENHUM "Legacy" no log
```

---

## 🎯 SANITY CHECKS (2 min)

### 6. Endpoints Respondendo
```bash
curl http://localhost:5000/api/v2/appointments/health
→ 200 OK
```

### 7. MongoDB Índices
```bash
# Verificar se índices existem
show indexes on appointments
show indexes on packages
```

---

## 🚀 DEPLOY (2 min)

### 8. Comando de Deploy
```bash
# Staging primeiro (se tiver)
git push origin main

# Produção
npm run deploy:prod
# ou
pm2 restart server
```

---

## ✅ PÓS-DEPLOY (5 min)

### 9. Verificação Imediata
```bash
# Health check
curl https://api.fonoinova.com/health

# Métricas
pm2 status
pm2 logs --lines 20
```

### 10. Validação de Negócio
```bash
# Criar 1 pacote de teste real
# Completar 1 sessão
# Verificar no dashboard se balance aparece
```

---

## 🚨 ROLLBACK (se necessário)

```bash
# Emergência - voltar em 30 segundos
git revert HEAD
npm run deploy:prod
```

---

## 📊 MONITORAMENTO (primeiras 2h)

### Alertas para observar:
- [ ] Erro 500 em `/v2/appointments/*/complete`
- [ ] Balance com `NaN` ou `undefined`
- [ ] Mensagens de erro no worker
- [ ] Latência > 2s no complete

### Comando útil:
```bash
pm2 logs | grep -E "(ERROR|complete|billing)" | tail -50
```

---

## ✅ CHECKLIST FINAL

| Item | Status |
|------|--------|
| Testes passaram | ⬜ |
| Logs limpos | ⬜ |
| Health OK | ⬜ |
| Deploy feito | ⬜ |
| Pós-deploy validado | ⬜ |
| Monitoramento ativo | ⬜ |

---

## 💀 DECISÃO FINAL

Se todos ⬜ → ✅:
```
🎉 DEPLOY AUTORIZADO
```

Se qualquer ❌:
```
⛔ NÃO DEPLOYAR - Corrigir primeiro
```

---

**Tempo total:** ~30 minutos  
**Risco residual:** < 5%  
**Confiança:** Produção-ready 💀
