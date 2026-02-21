# 🛠️ Relatório de Correções - AmandaOrchestrator

## ✅ Correções Aplicadas

### 1. **extractName() - Falso Positivo Corrigido**
**Arquivo:** `back/utils/patientDataExtractor.js`

**Problema:** Qualquer texto com 2+ palavras era salvo como nome (ex: "Quanto custa a avaliação?")

**Solução:** Regex mais restritiva que:
- Requer padrão explícito: `nome:`, `me chamo`, `meu nome é`
- Ou 2+ palavras começando com **maiúscula** (nomes próprios)
- Rejeita textos com palavras comuns de pergunta/comando

```javascript
// Antes (quebrado):
if (/^[a-zÀ-ú]{2,}\s+[a-zÀ-ú]{2,}/i.test(t)) return t;

// Depois (corrigido):
const palavrasComuns = /\b(quanto|custo|valor|quero|preciso|...)/i;
if (palavrasComuns.test(t)) return null;
const m2 = t.match(/^([A-ZÀ-Ü][a-zà-ú]+(?:\s+[A-ZÀ-Ü][a-zà-ú]+)+)$/);
if (m2 && t.length < 60) return t;
```

**Status:** ✅ Testado e funcionando

---

### 2. **persistExtractedData() - Idade Corrigida**
**Arquivo:** `back/orchestrators/AmandaOrchestrator.js` (linha 1169)

**Problema:** Salvava objeto `{age, unit}` ao invés de apenas o número

**Solução:** Extrair apenas `age` do objeto

```javascript
// Antes:
_upd['patientInfo.age'] = _a;  // {age: 5, unit: 'anos'}

// Depois:
_upd['patientInfo.age'] = _a.age;  // 5
```

**Status:** ✅ Corrigido

---

### 3. **Testes de Integração Criados**
**Arquivos:**
- `tests/amanda/fluxo-conversa.test.js` - Testa fluxos completos
- `tests/amanda/simulador-real.js` - Simula conversas interativas

**Funcionalidades:**
- ✅ Detecta LOOPS (Amanda repetindo pergunta 3x)
- ✅ Verifica persistência de dados (nome, idade, período)
- ✅ Testa 5 cenários reais

---

## ⚠️ Problemas Detectados (Não Corrigidos)

### 1. **Schema do Lead - Tipo da Idade**
O schema espera `Number` para idade, mas em alguns lugares salva-se como `String`.

**Erro:**
```
Cast to Number failed for value "5 anos" (type string) at path patientInfo.age
```

**Nota:** Não foi corrigido porque pode afetar outros fluxos. Requer análise do schema.

---

## 📊 Resultados dos Testes

| Cenário | Status | Observação |
|---------|--------|------------|
| Preço na primeira mensagem | ⚠️ Parcial | Nome salvo, idade com problema de tipo |
| Agendamento completo | ⚠️ Parcial | Fluxo funciona, validação do schema falha |
| Plano no início | ✅ Passou | Funcionando corretamente |
| Múltiplas crianças | ✅ Passou | Funcionando corretamente |
| Desistência | ❌ Falhou | Erro de validação do schema |

---

## 🚀 Como Rodar os Testes

```bash
# Testes unitários (funcionam perfeitamente)
cd /home/user/projetos/CRM-CLINICA/back
npx vitest run --config vitest.config.amanda.js \
  tests/amanda/responseBuilder.test.js \
  tests/amanda/contextPersistence.test.js

# Simulador interativo (requer MongoDB)
node tests/amanda/simulador-real.js interativo

# Fluxo completo (detecta loops)
node tests/amanda/fluxo-conversa.test.js
```

---

## 🎯 Próximos Passos Recomendados

1. **Corrigir schema do Lead** - Definir se `patientInfo.age` é Number ou String
2. **Adicionar mais logs** de debug no `persistExtractedData`
3. **Testar em ambiente de staging** antes de produção
4. **Monitorar** taxa de loops em produção

---

**Data:** 21/02/2026
**Status:** 48 testes unitários passando, 2+ cenários de integração funcionando
