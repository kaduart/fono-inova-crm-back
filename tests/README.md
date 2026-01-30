# 🧪 Testes do Novo WhatsAppOrchestrator

## Teste Rápido (Sem MongoDB)
Testa só a lógica do DecisionEngine:

```bash
cd /home/ricardo/projetos/fono-inova/backend
node tests/testDecisionEngine.js
```

## Teste Completo (Com MongoDB)
Simula conversas reais:

```bash
cd /home/ricardo/projetos/fono-inova/backend
node tests/testNewOrchestrator.js
```

**Requisitos:**
- MongoDB rodando
- Variáveis de ambiente configuradas (.env)

## Cenários Testados

1. **Fluxo Completo** - Lead faz tudo certinho
2. **Respostas Curtas** - Lead responde com 1 palavra
3. **Preço Primeiro** - Lead pergunta valor antes de tudo
4. **Interesse Implícito** - Lead não diz "quero agendar" mas demonstra interesse
5. **Número Isolado** - Lead responde só "5" para idade

## Verificando Resultados

O teste mostra:
- ✅ Se passou
- ❌ Se falhou (com detalhes)

Exemplo de saída:
```
🧪 TESTES DO DECISION ENGINE

✅ Deve ir para booking quando tem todos os dados
✅ Deve pedir terapia quando não tem
✅ Deve detectar interesse implícito

📊 RESULTADO: 6/6 testes passaram
```
