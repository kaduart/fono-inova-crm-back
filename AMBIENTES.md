# 🎯 Gestão de Ambientes - Produção vs Desenvolvimento

## 📁 Estrutura de Bancos

```
crm_production    → DADOS REAIS (cuidado!)
crm_development   → Cópia para testes (pode quebrar à vontade)
```

---

## 🚀 Comandos Rápidos

### 1. Configurar pela primeira vez
```bash
node scripts/setup-environments.js
```
Isso cria:
- `.env.production` → aponta para crm_production
- `.env.development` → aponta para crm_development

### 2. Alternar entre ambientes

**Para DESENVOLVIMENTO (testes):**
```bash
./scripts/switch-env.sh development
npm run dev
```

**Para PRODUÇÃO (cuidado!):**
```bash
./scripts/switch-env.sh production
npm run dev
```

### 3. Verificar qual ambiente está ativo
```bash
grep "MONGO_URI" .env
```

---

## 🛡️ Regras de Ouro

| Ambiente | Pode testar 4.0? | Pode quebrar? | Dados são reais? |
|----------|-----------------|---------------|------------------|
| **production** | ⚠️ Com MUITO cuidado | ❌ NUNCA | ✅ Sim |
| **development** | ✅ Sim, à vontade | ✅ Pode limpar | ❌ Cópia |

---

## 🧪 Fluxo de Trabalho Recomendado

### Durante desenvolvimento 4.0:
```bash
# 1. Sempre use development para codar
./scripts/switch-env.sh development

# 2. Rode o servidor
npm run dev

# 3. Teste tudo no Bruno (create, complete, cancel)

# 4. Se quebrar, limpa e reinicia:
#    (só afeta development, production está seguro)
```

### Antes de subir para produção:
```bash
# 1. Valida tudo em development
./scripts/switch-env.sh development
node scripts/audit-financial-integrity.js

# 2. Só então muda para production
./scripts/switch-env.sh production

# 3. Roda auditoria em produção
node scripts/audit-financial-integrity.js

# 4. Ativa feature flags gradualmente
```

---

## 📊 Status dos Ambientes

```bash
# Ver bancos existentes
node -e "
const mongoose = require('mongoose');
const uri = process.env.MONGO_URI.replace(/\/[^/]*$/, '');
mongoose.connect(uri).then(async () => {
  const admin = mongoose.connection.db.admin();
  const dbs = await admin.listDatabases();
  console.log('Bancos:', dbs.databases.map(d => d.name).join(', '));
  process.exit(0);
});
"
```

---

## ⚠️ Emergência

**Se tiver medo de estar em production:**
```bash
# Verifica rapidamente
grep "MONGO_URI" .env

# Se tiver "production" no meio, CUIDADO!
# Se tiver "development", pode brincar à vontade
```

---

## 📝 Arquivos Gerados

| Arquivo | Função |
|---------|--------|
| `.env.production` | Config do banco real |
| `.env.development` | Config do banco de teste |
| `.env.backup` | Backup do último .env |
| `.env` | Atual (copiado de um dos acima) |
