# 🧪 Amanda Flow Tests - Enterprise Edition

> **Testes que validam COMPORTAMENTO, não SEQUÊNCIA.**

## 🎯 Filosofia Enterprise

Esta suite de testes não verifica se a Amanda segue um roteiro rígido. Em vez disso, valida que ela:

1. **Responde corretamente** em qualquer contexto
2. **Não repete perguntas** já respondidas
3. **Preserva contexto** entre mensagens
4. **Lida com múltiplas variações** de entrada
5. **Mantém coerência** independente da ordem

## 🚀 Como Executar

```bash
cd backend && npm test
```

## 📁 Arquivos de Teste

| Arquivo | Descrição | Cobertura | Como Executar |
|---------|-----------|-----------|---------------|
| `persistencia-dados.test.js` | 🆕 Teste de integração (Node) | Persistência no MongoDB | `node tests/amanda/persistencia-dados.test.js` |
| `responseBuilder.test.js` | 🆕 Testes do ResponseBuilder | Auto-respostas baseadas em flags | `npm run test:amanda -- responseBuilder` |
| `contextPersistence.test.js` | 🆕 Testes de Persistência | Extração e persistência de dados | `npm run test:amanda -- contextPersistence` |
| `flows.test.js` | Fluxos de conversa | Testes de fluxo completos | `npm run test:amanda -- flows` |
| `dynamic-modules.test.js` | Módulos dinâmicos | Carregamento de módulos | `npm run test:amanda -- dynamic-modules` |
| `real-world-cases.test.js` | Casos reais | Casos extraídos de conversas | `npm run test:amanda -- real-world-cases` |

## 📋 Cenários de Teste (Behavioral-Driven)

| ID | Nome | Descrição | Múltiplas Variações |
|----|------|-----------|---------------------|
| `FIRST_CONTACT_PRICE` | 💰 Primeiro Contato - Preço | Lead pergunta preço na primeira mensagem | ✅ 3 variações |
| `FIRST_CONTACT_GREETING` | 👋 Primeiro Contato - Saudação | Lead apenas cumprimenta | ✅ 3 variações |
| `CONTEXT_PRESERVATION` | 🔄 Preservação de Contexto | Dados informados são lembrados | ✅ Caminho flexível |
| `MULTIPLE_THERAPIES` | 🎯 Detecção Múltiplas Terapias | Quando menciona várias especialidades | ✅ 2 variações |
| `ADDRESS_QUESTION` | 📍 Pergunta Endereço | Lead pergunta onde fica | ✅ 3 variações |
| `INSURANCE_QUESTION` | 🏥 Pergunta Convênio | Lead pergunta sobre plano | ✅ 2 variações |
| `NO_REPEAT_QUESTIONS` | 🔥 NUNCA Repetir Perguntas | Se já respondeu, não pergunta de novo | ✅ 2 variações |

## 🔬 Exemplo: Teste de Comportamento

### ❌ Abordagem Antiga (Engessada)
```javascript
// Teste sequencial - FRÁGIL
const resposta = await amanda.responder("Oi");
assert(resposta.includes("Que bom que você entrou em contato!"));

const resposta2 = await amanda.responder("Quanto custa?");
assert(resposta2.includes("R$ 220"));
```

### ✅ Abordagem Enterprise (Robusta)
```javascript
// Teste comportamental - ROBUSTO
const resposta = await amanda.responder("Quanto custa?");
assertBehavior(resposta, {
    // Deve conter PELO MENOS UM destes
    shouldContainOneOf: ['situação', 'queixa', 'R$ 220', 'fono'],
    // NUNCA deve conter estes
    shouldNotContain: ['qual a idade', 'idade do paciente']
});
```

## 🎭 Variações Testadas

Cada cenário testa **múltiplas formas** de dizer a mesma coisa:

### Exemplo: Pergunta de Preço
- ✅ "Quanto custa?"
- ✅ "Tá quanto uma consulta com a fono?"
- ✅ "Qual o valor da avaliação?"

### Exemplo: Saudação
- ✅ "Oi"
- ✅ "Bom dia"
- ✅ "Olá, tudo bem?"

## 🔥 Validações Críticas

### 1. NUNCA Repetir Perguntas
```javascript
// Se lead já disse idade, NÃO pergunta de novo
{ text: 'Oi meu filho tem 7 anos' }  // → Resposta normal
{ text: 'Quanto custa?' }              // → NÃO deve conter "qual a idade"
```

### 2. Preservação de Contexto
```javascript
// Lead pode responder em qualquer ordem
{ text: 'Oi' }                          // → Amanda: "Qual a situação?"
{ text: 'Meu filho não fala' }          // → Amanda: "Qual idade?"
{ text: '5 anos' }                      // → Amanda: "Qual período?"
{ text: 'Quanto custa?' }               // → Amanda: Dá preço, NÃO repete idade
```

### 3. Flexibilidade de Entrada
```javascript
// Múltiplas formas de dizer "manhã"
"manhã" | "Manhã" | "MANHÃ" | "pela manhã" | "de manhã"
```

## 📊 Interpretando Resultados

```
✅ Passaram: 7/7     → Tudo certo! 🎉
❌ Falharam: 1/7     → Investigar comportamento
```

### Tipos de Falha:

| Tipo | Significado | Ação |
|------|-------------|------|
| `shouldContainOneOf` | Amanda não cobriu cenário esperado | Adicionar handler |
| `shouldNotContain` | Amanda repetiu pergunta | Corrigir lógica de contexto |
| `shouldMatch` | Resposta fora do padrão | Ajustar regex/template |

## 🛠️ Adicionar Novo Cenário

```javascript
{
    id: 'MEU_NOVO_CENARIO',
    name: '🎯 Nome Descritivo',
    description: 'O que este teste valida',
    phone: '556299999999',
    variations: [
        {
            name: 'Variação 1',
            messages: ['Texto do cliente']
        },
        {
            name: 'Variação 2',
            messages: ['Outro texto equivalente']
        }
    ],
    expectations: {
        firstResponse: {
            shouldContainOneOf: ['texto', 'esperado', 'resposta'],
            shouldNotContain: ['erro', 'problema']
        }
    }
}
```

## 🔄 Quando Executar

### OBRIGATÓRIO:
- [ ] Antes de todo deploy em produção
- [ ] Após alterações em `DecisionEngine.js`
- [ ] Após alterações em `WhatsAppOrchestrator.js`
- [ ] Após alterações em handlers

### RECOMENDADO:
- [ ] Após alterações em `flagsDetector.js`
- [ ] Após novas regras de negócio
- [ ] Semanalmente (CI/CD)

## 🚨 Diferença para Testes Antigos

| Aspecto | Testes Antigos | Testes Enterprise |
|---------|---------------|-------------------|
| Foco | Sequência fixa | Comportamento |
| Fragilidade | Alta (quebra com pequenas mudanças) | Baixa (flexível) |
| Variações | 1 por cenário | Múltiplas por cenário |
| Manutenção | Difícil | Fácil |
| Cobertura | Linear | Abrangente |

## ✅ Checklist de Qualidade

Antes de subir para produção:

- [ ] `npm test` retorna 7/7 passando
- [ ] Nenhum erro crítico nos logs
- [ ] Testado manualmente no WhatsApp (1 fluxo)
- [ ] Logs estruturados funcionando

---

---

## ⚠️ Atenção: Arquivos de Teste

### `testeAmanda.js` — NÃO USAR diretamente

O arquivo `testeAmanda.js` tem configurações padrão que **não funcionam**:
```javascript
API_URL: 'https://sua-api.com',  // ❌ URL fake
TOKEN: 'SEU_JWT_TOKEN',          // ❌ Token fake
```

**Erro típico:** `fetch failed`

**Solução:** Use o novo teste de integração que não requer servidor HTTP:
```bash
node tests/amanda/persistencia-dados.test.js
```

Ou configure corretamente as variáveis no `testeAmanda.js` antes de usar.

---

## 🆕 Novos Testes (Fev/2026)

### Persistência de Dados (`persistencia-dados.test.js`)

Teste de integração que verifica se os dados extraídos das mensagens são persistidos corretamente no MongoDB, mesmo em fluxos de bypass (preço, endereço, etc).

```bash
# NÃO requer servidor HTTP rodando
node tests/amanda/persistencia-dados.test.js
```

**Cobertura:**
- ✅ Persistência de nome, idade e período
- ✅ Não sobrescreve dados já coletados
- ✅ Extração com padrão "nome:" (recomendado)
- ✅ Documentação dos comportamentos das funções

**⚠️ Limitações conhecidas:**
- `extractName()` pode ter falso positivo se o texto começar com 2+ palavras
- Recomenda-se usar padrão explícito: `"nome: [nome completo]"`

### ResponseBuilder Tests (`responseBuilder.test.js`)

Testa o serviço de respostas automáticas baseadas em flags.

```bash
npm run test:amanda -- tests/amanda/responseBuilder.test.js
```

**Cobertura:**
- ✅ `canAutoRespond()` - Detecção de flags para auto-resposta
- ✅ `buildResponseFromFlags()` - Construção de respostas (preço, planos, endereço, horários)
- ✅ `getTherapyInfo()` - Metadados de terapias

**Exemplo de teste:**
```javascript
it('deve retornar preço específico para neuropsicologia', () => {
  const flags = { asksPrice: true };
  const context = { therapyArea: 'neuropsicologia' };
  const response = buildResponseFromFlags(flags, context);
  
  expect(response).toContain('R$ 2.000');
  expect(response).toContain('6x');
});
```

### Context Persistence Tests (`contextPersistence.test.js`)

Testa a persistência automática de dados extraídos das mensagens.

```bash
npm run test:amanda -- tests/amanda/contextPersistence.test.js
```

**Cobertura:**
- ✅ `getMissingFields()` - Lista campos que ainda faltam coletar
- ✅ `extractName()` - Extrai nome do texto do usuário
- ✅ `extractAgeFromText()` - Extrai idade (anos/meses)
- ✅ `extractPeriodFromText()` - Extrai período preferido
- ✅ Construção de `knownDataNote` e `missingFieldsNote`

**Exemplo de teste:**
```javascript
it('deve retornar apenas campos realmente faltantes', () => {
  const lead = {
    patientInfo: { fullName: 'Ana Costa', age: '3 anos' },
    therapyArea: 'psicologia'
  };
  const missing = getMissingFields(lead);
  
  expect(missing).not.toContain('nome do paciente');
  expect(missing).not.toContain('idade');
  expect(missing).toContain('período (manhã ou tarde)');
});
```

---

**Última atualização:** 21/02/2026  
**Status:** ✅ 48/48 Testes Passando (incluindo novos)
