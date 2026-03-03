# 🎯 Testes de Conversas Reais - Amanda AI

Sistema de validação de respostas da Amanda usando **cenários baseados em conversas reais** de WhatsApp.

## 📂 Estrutura

```
conversas-reais/
├── fluxos-completos/     # Cenários de fluxo completo
│   └── fluxo-fono.json   # Ex: "Oi → 5 anos → não fala → pacote"
├── cenarios-criticos/    # Cenários críticos
│   └── objecao-preco.json # Ex: "Muito caro"
├── edge-cases/           # Casos extremos
│   └── contexto-irrelevante.json # Ex: "Tá chovendo"
├── executar-testes.js    # Executor
└── README.md
```

## 🚀 Como Usar

### 1. Rodar um cenário específico

```bash
node back/tests/conversas-reais/executar-testes.js --cenario=fluxos-completos/fluxo-fono.json
```

### 2. Rodar todos os cenários

```bash
node back/tests/conversas-reais/executar-testes.js --all
```

### 3. Modo interativo (pausa entre mensagens)

```bash
node back/tests/conversas-reais/executar-testes.js --all --interativo
```

## 📋 Formato de Cenário

```json
{
  "nome": "Nome do Cenário",
  "descricao": "Descrição do que está sendo testado",
  "tags": ["tag1", "tag2"],
  "leadInicial": {
    "therapyArea": "fonoaudiologia",
    "patientInfo": { "fullName": "João", "age": 5 }
  },
  "mensagens": [
    {
      "ordem": 1,
      "tipo": "usuario",
      "texto": "Oi",
      "intencao": "saudacao",
      "esperado": {
        "respostaContem": ["Oi", "tudo bem"],
        "naoDeveConter": ["Olá"],
        "empatia": true,
        "scoreMinimo": 8,
        "critico": false
      }
    }
  ]
}
```

## 🎯 Critérios de Avaliação

### Respostas esperadas
- **`respostaContem`**: Lista de palavras/frases que DEVEM estar na resposta
- **`naoDeveConter`**: Lista de palavras/frases que NÃO DEVEM estar

### Comportamento
- **`empatia`**: Resposta demonstra entendimento do usuário
- **`personalizacao`**: Usa nome do paciente/lead
- **`naoPressiona`**: Não usa táticas agressivas de vendas
- **`contextoRecuperado`**: Mantém informações de mensagens anteriores

### Scores
- **10**: Perfeita
- **8-9**: Excelente
- **6-7**: Aceitável
- **<6**: Precisa melhorar

## 🔴 Cenários Críticos

Marcados com `"critico": true` - se falhar, deve bloquear deploy!

- **Recuperação de contexto**: Não repetir perguntas
- **Empatia em objeção**: Não pressionar quando usuário hesita
- **Venda psicológica**: Não ser agressiva/comercial demais

## 📊 Relatório

Após execução, gera `relatorio-YYYY-MM-DD-HH-MM.json` com:
- Score geral
- Detalhe por cenário
- Falhas específicas

## 💡 Dicas

1. **Criar novo cenário**: Copie `fluxo-fono.json` como template
2. **Validar sintaxe**: Use `node -e "JSON.parse(require('fs').readFileSync('arquivo.json'))"`
3. **Mensagens ruins**: Coloque em `edge-cases/` - servem de "vacina"
