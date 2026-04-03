# 🔧 PATCH: Correção de billingType para Convênio V2

## 📋 Resumo

Corrige a inconsistência onde appointments de pacotes de convênio estavam sendo criados com `billingType: "particular"` ao invés de `billingType: "convenio"`.

## 🎯 Alterações

### 1. Controller de Criação de Pacote de Convênio
**Arquivo:** `controllers/convenioPackageController.js`

```javascript
// ADICIONADO: billingType: 'convenio' na criação do appointment
const appointments = insertedSessions.map(s => ({
  // ... outros campos
  serviceType: 'convenio_session',
  billingType: 'convenio',  // ✅ NOVO
  // ... resto
}));
```

### 2. Script de Correção de Dados Existentes
**Arquivo:** `scripts/fix-convenio-billingType.js`

Para corrigir dados legados, execute:
```bash
cd back
node scripts/fix-convenio-billingType.js
```

## ✅ Checklist de Validação

| Item | Status |
|------|--------|
| Novos pacotes criam appointments com billingType="convenio" | ✅ |
| Script de correção para dados existentes | ✅ |
| InsuranceBillingService V2 já usa billingType correto | ✅ |
| Relatórios financeiros devem usar billingType para filtrar | ⚠️ Verificar |

## 🧪 Teste Rápido

1. Criar pacote de convênio:
```bash
POST /api/convenio-packages
```

2. Verificar appointments criados:
```bash
GET /api/v2/appointments?packageId=...
```

3. Validar:
```json
{
  "billingType": "convenio",
  "paymentMethod": "convenio",
  "serviceType": "convenio_session"
}
```

## 🚀 Próximos Passos

1. Executar script de correção em produção (se necessário)
2. Verificar relatórios que usam billingType
3. Garantir que dashboard financeiro separa particular/convenio corretamente
