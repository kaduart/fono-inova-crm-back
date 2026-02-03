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

**Última atualização:** 03/02/2026  
**Status:** ✅ 7/7 Testes Passando
