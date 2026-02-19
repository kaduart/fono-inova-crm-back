# ✅ Checklist de Testes - Antes de Subir para Produção

Use este checklist antes de fazer deploy das APIs de integração.

## 🚀 Setup Inicial (Executar uma vez)

```bash
cd ~/projetos/CRM-CLINICA/back

# 1. Instalar dependências de teste
bash scripts/setup-tests.sh

# Ou manualmente:
npm install --save-dev mongodb-memory-server@^9.0.0 supertest@^6.3.0

# 2. Criar arquivo .env.test
cat > .env.test << EOF
NODE_ENV=test
JWT_SECRET=test_secret_nao_usar_em_producao
AGENDA_EXPORT_TOKEN=agenda_export_token_test_12345
ADMIN_API_TOKEN=admin_api_token_test_67890
EOF

# 3. Validar setup
npm run test:agenda-externa -- validate-setup.test.js
```

## 🧪 Testes Obrigatórios

### 1. Validação do Ambiente
```bash
npm run test:agenda-externa -- validate-setup.test.js
```
- [ ] Variáveis de ambiente configuradas
- [ ] MongoDB conectado
- [ ] Models importáveis
- [ ] Middlewares funcionando

### 2. APIs de Integração
```bash
npm run test:agenda-externa -- agenda-externa.test.js
```
- [ ] `POST /api/import-from-agenda/sync-update` - Sucesso
- [ ] `POST /api/import-from-agenda/sync-update` - 404 quando não existe
- [ ] `POST /api/import-from-agenda/sync-update` - 401 com token inválido
- [ ] `POST /api/import-from-agenda/sync-delete` - Sucesso
- [ ] `POST /api/import-from-agenda/sync-cancel` - Sucesso
- [ ] `POST /api/import-from-agenda` - Criar pré-agendamento
- [ ] `POST /api/import-from-agenda/confirmar-por-external-id` - Confirmar
- [ ] `DELETE /api/appointments/:id` - Aceita service token
- [ ] `POST /api/pre-agendamento/webhook` - Receber webhook

### 3. Casos de Borda (Bugs de Produção)
```bash
npm run test:agenda-externa -- agenda-externa.edge-cases.test.js
```
- [ ] Não há double commit em sync-update
- [ ] Dados do paciente retornam birthDate, email, phone
- [ ] DELETE aceita AGENDA_EXPORT_TOKEN
- [ ] Timeout não ocorre em updates
- [ ] Múltiplos updates simultâneos funcionam

### 4. Todos os Testes
```bash
npm run test:agenda-externa
```
- [ ] Todos os testes passam
- [ ] Cobertura > 80%

## 🔍 Testes Manuais (API)

### Testar sync-update
```bash
curl -X POST https://fono-inova-crm-back.onrender.com/api/import-from-agenda/sync-update \
  -H "Authorization: Bearer $AGENDA_EXPORT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "externalId": "ID_DO_APPOINTMENT",
    "date": "2026-03-01",
    "time": "10:00"
  }'
```

### Testar sync-delete
```bash
curl -X POST https://fono-inova-crm-back.onrender.com/api/import-from-agenda/sync-delete \
  -H "Authorization: Bearer $AGENDA_EXPORT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "externalId": "ID_DO_APPOINTMENT",
    "reason": "Teste de integração"
  }'
```

### Testar DELETE /appointments
```bash
curl -X DELETE https://fono-inova-crm-back.onrender.com/api/appointments/ID_AQUI \
  -H "Authorization: Bearer $AGENDA_EXPORT_TOKEN"
```

## 📊 Métricas de Qualidade

| Métrica | Mínimo | Atual |
|---------|--------|-------|
| Cobertura de código | 80% | ?% |
| Testes passando | 100% | ?% |
| Tempo de execução | <60s | ?s |
| Bugs de produção | 0 | ? |

## 🐛 Bugs Conhecidos

### Bug #1: Double Commit (RESOLVIDO)
- **Sintoma**: Timeout de 10000ms em sync-update
- **Causa**: Dois `session.commitTransaction()` na rota
- **Solução**: Removido segundo commit
- **Teste**: `agenda-externa.edge-cases.test.js` - "deve completar update sem erro"

### Bug #2: Dados do Paciente (RESOLVIDO)
- **Sintoma**: birthDate, email não carregam no modal
- **Causa**: appointmentMapper não incluía campos
- **Solução**: Adicionados phone, dateOfBirth, email no retorno
- **Teste**: `agenda-externa.edge-cases.test.js` - "deve retornar birthDate"

### Bug #3: Autenticação DELETE (RESOLVIDO)
- **Sintoma**: INVALID_TOKEN ao deletar da agenda externa
- **Causa**: Rota usava `auth` em vez de `flexibleAuth`
- **Solução**: Trocado para flexibleAuth
- **Teste**: `agenda-externa.edge-cases.test.js` - "deve aceitar AGENDA_EXPORT_TOKEN"

## 📝 Pre-Deploy Checklist

- [ ] Todos os testes passam localmente
- [ ] Não há `console.log` de debug no código
- [ ] Variáveis de ambiente de produção configuradas
- [ ] AGENDA_EXPORT_TOKEN está definido no Render
- [ ] JWT_SECRET é diferente do ambiente de teste
- [ ] Redis está configurado e acessível
- [ ] MongoDB está acessível

## 🚨 Post-Deploy Checklist

- [ ] Testar sync-update no ambiente de produção
- [ ] Testar sync-delete no ambiente de produção
- [ ] Testar DELETE /appointments com token de serviço
- [ ] Verificar logs de erro no Render
- [ ] Monitorar tempo de resposta das APIs

## 🔄 CI/CD Pipeline

```yaml
# .github/workflows/test.yml
name: Tests

on: [push]

jobs:
  integration-tests:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
          
      - run: npm ci
      
      - run: npm run test:agenda-externa
        env:
          AGENDA_EXPORT_TOKEN: ${{ secrets.AGENDA_EXPORT_TOKEN_TEST }}
          JWT_SECRET: ${{ secrets.JWT_SECRET_TEST }}
```

## 📞 Debug

### Se um teste falhar:

1. **Verifique o log detalhado**:
```bash
npm run test:agenda-externa -- --reporter=verbose
```

2. **Execute apenas o teste falho**:
```bash
npm run test:agenda-externa -- -t "nome do teste"
```

3. **Verifique a conexão MongoDB**:
```bash
npm run test:agenda-externa -- validate-setup.test.js
```

4. **Limpe o cache**:
```bash
rm -rf node_modules/.vitest
cd back && rm -rf ~/.cache/mongodb-memory-server
```

---

**⚠️ NUNCA suba para produção se algum teste estiver falhando!**
