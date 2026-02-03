# 🧪 Amanda Flow Tests

Testes automatizados para validar os fluxos de conversação da Amanda (WhatsApp Bot).

## ⚠️ IMPORTANTE - LEIA ANTES DE ALTERAR

> **Sempre execute estes testes antes de subir alterações para produção!**
> 
> Qualquer mudança no `WhatsAppOrchestrator`, `DecisionEngine` ou handlers pode quebrar os fluxos existentes.

## 📁 Estrutura

```
tests/amanda/
├── README.md           # Este arquivo
├── flows.test.js       # Testes principais (cenários)
├── run-tests.sh        # Script de execução fácil
├── bootstrap.js        # Carrega dotenv antes dos imports
└── package.json        # Configuração npm (test)
```

## 🚀 Como Executar

### Opção 1: NPM (Recomendado)
```bash
cd backend
npm test
```

### Opção 2: Script Shell
```bash
cd backend/tests/amanda
./run-tests.sh
```

### Opção 3: Node Direto
```bash
cd backend
node tests/amanda/bootstrap.js
```

## 📋 Cenários de Teste (5/5 Passando ✅)

| ID | Nome | Descrição | Critérios |
|----|------|-----------|-----------|
| `PRICE_FIRST_CONTACT` | 💰 Primeiro contato - Preço | Lead pergunta preço na 1ª mensagem | Acolher + Preço + Perguntar QUEIXA (não idade!) |
| `GREETING_ONLY` | 👋 Primeiro contato - Só "Oi" | Saudação simples | Acolher + Perguntar queixa |
| `NO_REPEAT_AGE` | 🔥 Nunca repetir idade | Lead já informou idade | NUNCA repetir pergunta da idade |
| `SCHEDULING_FLOW` | 📅 Fluxo agendamento | "Quero agendar" | Perguntar queixa primeiro |
| `MULTI_STEP_CONTEXT` | 🔄 Fluxo multi-passos | Queixa → Terapia → Idade → Período | Contexto preservado entre mensagens |

## 🔧 Requisitos

- Node.js 18+
- MongoDB (configurado no `.env`)
- Redis (opcional, testes funcionam sem)

## ⚙️ Variáveis de Ambiente

O teste usa o `.env` da pasta `backend/`:

```env
MONGO_URI=mongodb://... ou mongodb+srv://...
REDIS_HOST=localhost
REDIS_PORT=6379
OPENAI_API_KEY=sk-...
```

## 🔄 Quando Executar

### OBRIGATÓRIO executar antes de subir:
- [ ] Alterações em `WhatsAppOrchestrator.js`
- [ ] Alterações em `DecisionEngine.js`
- [ ] Alterações em handlers (`leadQualificationHandler.js`, etc)
- [ ] Alterações em `flagsDetector.js`
- [ ] Novas regras de negócio
- [ ] Alterações na ordem do fluxo (Queixa → Terapia → Idade → Período)

### RECOMENDADO executar:
- [ ] Alterações em modelos (`Leads.js`, `ChatContext.js`)
- [ ] Alterações em serviços de booking
- [ ] Atualizações de dependências

## 🛠️ Adicionar Novo Cenário

1. Edite `flows.test.js`
2. Adicione ao array `SCENARIOS`:

```javascript
{
    id: 'MEU_NOVO_CENARIO',
    name: '🎯 Nome do Cenário',
    phone: '556299999999',
    description: 'O que este teste valida',
    messages: [
        {
            text: 'Mensagem do cliente',
            validate: (response) => ({
                pass: response.includes('esperado'),
                error: 'Mensagem de erro se falhar'
            })
        }
    ]
}
```

3. Execute os testes para verificar: `npm test`

## 📊 Interpretando Resultados

```
✅ Passaram: 5/5     → Tudo certo, pode subir!
❌ Falharam: 1/5     → Corrija antes de subir
```

### Erros comuns:
- **"Não perguntou a queixa"** → Fluxo pulou etapa
- **"Repetiu pergunta da idade"** → Contexto não preservado
- **"Perguntou idade antes da queixa"** → Ordem do fluxo errada

## 📝 Checklist Pré-Deploy

- [ ] Executar `npm test` na pasta `backend/`
- [ ] Todos os 5 cenários passaram
- [ ] Verificar logs de erro (se houver)
- [ ] Testar manualmente no WhatsApp (1 fluxo completo)
- [ ] Confirmar que não há regressões

## 🎯 Arquitetura dos Testes

```
┌─────────────────────────────────────────┐
│           TESTE AUTOMATIZADO            │
├─────────────────────────────────────────┤
│  1. Criar Lead de teste                 │
│  2. Simular mensagens do cliente        │
│  3. Validar respostas da Amanda         │
│  4. Verificar contexto persistido       │
│  5. Limpar dados de teste               │
└─────────────────────────────────────────┘
```

### Fluxo Validado:
```
Cliente: "Oi" 
   ↓
Amanda: "Oi! Que bom que você entrou em contato! ... Qual a situação?"
   ↓
Cliente: "Meu filho não fala direito"
   ↓
Amanda: "Qual a idade do paciente?" (detectou: queixa=fono)
   ↓
Cliente: "5 anos"
   ↓
Amanda: "Prefere manhã ou tarde?"
```

## 👥 Contato

Em caso de dúvidas sobre os testes, consulte:
- Documentação da Amanda: `backend/orchestrators/README.md`
- Arquitetura: `PERFORMANCE_IMPLEMENTATION_GUIDE.md`
- Código fonte: `backend/orchestrators/WhatsAppOrchestrator.js`

---

**Última atualização:** 03/02/2026  
**Status:** ✅ Todos os testes passando
