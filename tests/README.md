# 🧪 Suite de Testes - Amanda AI

Suite completa de testes para validar qualidade, correção e eficácia da Amanda AI.

## 📁 Arquivos

| Arquivo | Descrição | Uso |
|---------|-----------|-----|
| `realConversationTester.js` | Testa com conversas reais do MongoDB | `node realConversationTester.js` |
| `fieldPopulationTest.js` | Valida preenchimento de campos | `node fieldPopulationTest.js` |
| `psychologicalSalesTest.js` | Avalia "venda psicológica" | `node psychologicalSalesTest.js` |
| `testContextRecovery.js` | Testa recuperação de contexto | `node testContextRecovery.js` |
| `runAllTests.js` | Orquestra todos os testes | `node runAllTests.js` |

---

## 🚀 Como Usar

### 1. Teste Rápido (Contexto)
```bash
cd back
cp .env.example .env  # Se não tiver
node tests/testContextRecovery.js
```

### 2. Teste de Preenchimento de Campos
```bash
node tests/fieldPopulationTest.js
```

**Valida:**
- ✅ Extração de therapyArea
- ✅ Extração de nome
- ✅ Extração de idade (números e por extenso)
- ✅ Extração de período
- ✅ Recuperação de contexto
- ✅ Correção de dados

### 3. Teste de Venda Psicológica
```bash
node tests/psychologicalSalesTest.js
```

**Avalia:**
- ✅ Empatia e acolhimento
- ✅ Linguagem suave (não agressiva)
- ✅ Convite vs imposição
- ✅ Personalização
- ✅ Transmissão de esperança
- ✅ Evita pressão/comercialismo

**Critérios de Pontuação:**
| Critério | Peso | Descrição |
|----------|------|-----------|
| Empatia | +3 | "Entendo como deve ser difícil..." |
| Validação | +2 | "É normal se sentir assim..." |
| Esperança | +2 | "Vamos conseguir ajudar..." |
| Convite | +2 | "Se quiser, podemos..." |
| Pressão | -4 | "Corre, última vaga!" |
| Imposição | -3 | "Você precisa agendar" |

### 4. Teste com Dados Reais
```bash
# Testa leads convertidos
TEST_MODE=converted node tests/realConversationTester.js

# Testa leads perdidos
TEST_MODE=lost node tests/realConversationTester.js

# Testa conversas longas
TEST_MODE=long node tests/realConversationTester.js
```

### 5. Todos os Testes (Completo)
```bash
# Todos
node tests/runAllTests.js

# Selecionados
TEST_SUITES=fields,psychological node tests/runAllTests.js
```

---

## 📊 Relatórios

Todos os testes geram relatórios em:
```
back/test-reports/
├── conversation-test-[timestamp].json
├── field-population-[timestamp].json
├── psychological-sales-[timestamp].json
├── context-recovery-[timestamp].json
└── master-report-[timestamp].html  ⭐ Relatório unificado
```

**Abra o HTML** no navegador para visualização completa!

---

## 🎯 Interpretando Resultados

### Score de Venda Psicológica
```
9-10: EXCELENTE - Resposta acolhedora, empática, convidativa
7-8:  BOA - Boa abordagem, pequenos ajustes
5-6:  REGULAR - Muito neutra ou comercial demais
3-4:  RUIM - Agressiva ou robótica
0-2:  PÉSSIMA - Pressão excessiva ou sem empatia
```

### Métricas de Campo
```
 therapyArea: 95%  ✅ Excelente
 patientName: 80%  ✅ Bom
 patientAge:  75%  ⚠️  Melhorar
 period:      90%  ✅ Excelente
```

### Recuperação de Contexto
```
Contexto recuperado: 92%  ✅
Significa: Em 92% das vezes, a Amanda lembrou dados já coletados
```

---

## 🔧 Cenários de Teste

### Cenários Incluídos

1. **Fluxo Completo** - Do "Oi" ao agendamento
2. **Contexto Recuperado** - Lead já tem dados
3. **Queixa Implícita** - "Meu filho não fala"
4. **Múltiplas Info** - Tudo de uma vez
5. **Correção** - Mudança de dados
6. **Números por Extenso** - "cinco anos"
7. **Urgência** - "Preciso urgente"
8. **Objeção de Preço** - "Muito caro"
9. **Comparação** - "Estou vendo outras"
10. **Resistência** - "Não acredito em terapia"

---

## 💡 Dicas

### Antes do Deploy
```bash
# Rode todos os testes
npm run test:all

# Ou manualmente
node tests/runAllTests.js
```

### Monitoramento Contínuo
```bash
# Adicione ao cron (diário)
0 6 * * * cd /path/to/back && node tests/runAllTests.js >> logs/tests.log 2>&1
```

### Debug de Falhas
```bash
# Teste específico com logs detalhados
DEBUG=1 node tests/fieldPopulationTest.js

# Um cenário específico
TEST_SCENARIO="Fluxo Completo - Fono" node tests/fieldPopulationTest.js
```

---

## 🐛 Troubleshooting

### Erro: "MongooseError: Operation buffering timed out"
```bash
# Certifique-se que MongoDB está rodando
systemctl status mongod  # Linux
brew services list | grep mongodb  # Mac
```

### Erro: "Cannot find module"
```bash
# Instale dependências
cd back && npm install
```

### Erro: "Redis connection failed"
```bash
# Redis é opcional para os testes
# Os testes funcionam sem, mas algumas features são desativadas
```

---

## 📈 Evolução

Para acompanhar evolução da Amanda ao longo do tempo:

```bash
# Rode e salve com data
node tests/runAllTests.js

# Compare relatórios
# (Use ferramentas como jq para comparar JSONs)
```

---

## 🎨 Customização

### Adicionar Novo Cenário
```javascript
// Em fieldPopulationTest.js
const TEST_SCENARIOS = [
    // ... existentes
    {
        name: 'Meu Cenário',
        conversation: [
            { text: '...', expectedFields: {...} }
        ]
    }
];
```

### Ajustar Critérios de Avaliação
```javascript
// Em psychologicalSalesTest.js
this.positiveCriteria = {
    meuCriterio: {
        patterns: [/minha regex/i],
        weight: 2,
        name: 'Meu Critério'
    }
};
```

---

## 📞 Suporte

Em caso de dúvidas:
1. Verifique logs em `test-reports/`
2. Rode com `DEBUG=1` para mais detalhes
3. Abra o relatório HTML para visualização

---

**Última atualização:** 2024
**Versão da Suite:** 1.0.0
