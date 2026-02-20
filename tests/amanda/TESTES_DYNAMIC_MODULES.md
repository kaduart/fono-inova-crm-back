# 🧪 Testes para DYNAMIC_MODULES

## 📋 Resumo

Este diretório contém testes para garantir que o erro `DYNAMIC_MODULES is not defined` **NUNCA MAIS** ocorra em produção.

## 🚨 O que aconteceu (20/02/2026)

1. O `DYNAMIC_MODULES` foi esvaziado durante uma refatoração
2. O novo `AmandaOrchestrator.js` não importou o módulo
3. Código continuou usando `DYNAMIC_MODULES.consultoriaModeContext`
4. **Resultado**: Erro `ReferenceError: DYNAMIC_MODULES is not defined`
5. **Impacto**: Amanda não respondeu a leads por horas

## ✅ Testes Criados

### 1. `verify-dynamic-modules-fix.mjs` (SMOKE TEST)
**Propósito**: Verificação rápida e independente  
**Quando rodar**: Antes de cada deploy  
**Como rodar**:
```bash
cd back && node tests/amanda/verify-dynamic-modules-fix.mjs
```

**O que verifica**:
- ✅ DYNAMIC_MODULES está definido
- ✅ Tem conteúdo (não é vazio)
- ✅ Módulos críticos existem
- ✅ Função useModule está definida
- ✅ Ordem correta (definição antes do uso)

### 2. `smoke-dynamic-modules.test.js` (TESTE DE INTEGRAÇÃO)
**Propósito**: Teste rápido com Vitest  
**Quando rodar**: No CI/CD ou localmente  
**Como rodar**:
```bash
cd back && npm test -- smoke-dynamic-modules
```

**O que verifica**:
- ✅ Módulo carrega sem erro
- ✅ Não lança "DYNAMIC_MODULES is not defined"
- ✅ Funciona com toneMode = premium
- ✅ Funciona com toneMode = acolhimento
- ✅ Funciona sem toneMode

### 3. `dynamic-modules.test.js` (TESTE COMPLETO)
**Propósito**: Cobertura completa dos cenários  
**Quando rodar**: Antes de releases importantes  
**Como rodar**:
```bash
cd back && npm test -- dynamic-modules
```

**O que verifica**:
- ✅ Todos os módulos críticos existem
- ✅ Cenários que quebraram em produção
- ✅ Testes de regressão
- ✅ Contrato da função useModule

## 🔧 Como adicionar ao CI/CD

### GitHub Actions
```yaml
name: Test DYNAMIC_MODULES

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: cd back && npm ci
      
      - name: Run DYNAMIC_MODULES smoke test
        run: cd back && node tests/amanda/verify-dynamic-modules-fix.mjs
      
      - name: Run full tests
        run: cd back && npm test -- smoke-dynamic-modules
```

### Pre-commit hook
```bash
#!/bin/bash
# .git/hooks/pre-commit

echo "🔍 Verificando DYNAMIC_MODULES..."
node back/tests/amanda/verify-dynamic-modules-fix.mjs

if [ $? -ne 0 ]; then
    echo "❌ DYNAMIC_MODULES test failed!"
    exit 1
fi
```

## 📊 Checklist de Deploy

Antes de fazer deploy, verifique:

- [ ] Rodar `node tests/amanda/verify-dynamic-modules-fix.mjs`
- [ ] Rodar `npm test -- smoke-dynamic-modules`
- [ ] Verificar se não há erros no console
- [ ] Testar manualmente uma mensagem no WhatsApp (se possível)

## 🎯 Módulos Críticos

Se algum desses estiver faltando, o sistema pode não funcionar corretamente:

| Módulo | Função |
|--------|--------|
| `consultoriaModeContext` | Tom premium para leads quentes |
| `acolhimentoModeContext` | Tom empático para leads frios |
| `valueProposition` | Proposta de valor da clínica |
| `teaTriageContext` | Triagem para TEA/autismo |
| `priceObjection` | Quebra de objeção de preço |
| `schedulingContext` | Script de agendamento |

## 📝 Notas

- Os testes são **independentes** do banco de dados (quando possível)
- O smoke test pode rodar sem MongoDB
- O teste completo requer conexão com o banco

## 🆘 Em caso de falha

Se o teste falhar:

1. **NÃO FAÇA DEPLOY**
2. Verifique se `DYNAMIC_MODULES` foi acidentalmente removido
3. Verifique se há erros de sintaxe no arquivo
4. Compare com a versão anterior que funcionava
5. Corrija e rode os testes novamente

---

**Criado em**: 20/02/2026  
**Responsável**: Claude Code  
**Motivo**: Prevenir regressão do erro crítico que afetou leads em produção
