# 🚀 GUIA DE TESTES EM PRODUÇÃO - AMANDA

> ⚠️ **ATENÇÃO:** Siga este guia rigorosamente para evitar impacto em leads reais.

## 📋 CHECKLIST PRÉ-DEPLOY

Antes de subir para produção, execute local:

```bash
cd backend && npm test
```

- [ ] ✅ **7/7 testes passando**
- [ ] ✅ Sem erros de sintaxe
- [ ] ✅ Logs estruturados funcionando

---

## 🛡️ ESTRATÉGIAS DE DEPLOY SEGURO

### OPÇÃO 1: Feature Flag (RECOMENDADO)

Já implementado no código:

```javascript
// backend/controllers/whatsappController.js
const useNew = process.env.NEW_ORCHESTRATOR === "true";
```

#### Passo a passo:

**1. Deploy com flag DESLIGADA**
```bash
# No painel da Render/Railway/Vercel
NEW_ORCHESTRATOR=false

# Faça o deploy
```

**2. Valide que está funcionando (modo antigo)**
- Envie mensagem de teste para si mesmo
- Verifique se Amanda responde normalmente

**3. Ative para 1 número de teste**
```javascript
// Adicione seu número no CANARY_ENV
const CANARY_PHONES = [
    '55629XXXXXXXX',  // Seu número
    '556292013573',   // Número de teste existente
];
```

**4. Teste seu número**
- Envie: "Oi"
- Envie: "Quanto custa?"
- Envie: "Meu filho tem 5 anos"
- Verifique se o fluxo está correto

**5. Ative gradualmente**
```bash
# Dia 1: 10% dos leads
NEW_ORCHESTRATOR_PERCENTAGE=10

# Dia 2: 50% dos leads  
NEW_ORCHESTRATOR_PERCENTAGE=50

# Dia 3: 100%
NEW_ORCHESTRATOR_PERCENTAGE=100
```

---

### OPÇÃO 2: Canary Deployment (Números específicos)

Já implementado no código:

```javascript
// Verifica se é número de teste
const isTestNumber = (phone) => {
    const testNumbers = process.env.TEST_PHONES?.split(',') || [];
    return testNumbers.includes(phone);
};
```

#### Configuração:

**1. Adicione números de teste no .env**
```env
TEST_PHONES=5562999999991,5562999999992,5562999999993
```

**2. Deploy normal**

**3. Teste apenas esses números**
- Peça para amigos/familiares testarem
- Verifique logs específicos desses números

**4. Se OK, remova a restrição**

---

## 🧪 TESTES MANUAIS EM PRODUÇÃO

### Preparação

1. **Tenha acesso aos logs em tempo real:**
```bash
# Render
render logs --tail

# Railway
railway logs --tail

# Ou via dashboard web
```

2. **Prepare números de teste:**
- Seu celular pessoal
- Celular de um colega de confiança
- Número de teste da empresa

---

### Cenários de Teste Manual

Use este checklist durante os testes:

#### CENÁRIO 1: Primeiro Contato - Preço
```
Você: "Oi, quanto custa?"

✅ ESPERADO:
- Amanda acolhe ("Oi! Que bom que você entrou em contato...")
- Dá o preço ("R$ 200" ou similar)
- PERGUNTA QUEIXA ("Qual a situação...")

❌ PROBLEMA SE:
- Perguntar idade antes da queixa
- Não responder sobre preço
- Erro/sem resposta
```

#### CENÁRIO 2: Fluxo Completo
```
Você: "Oi"
Amanda: [Responde]

Você: "Meu filho não fala direito"
Amanda: [Deve perguntar idade OU reconhecer fono]

Você: "5 anos"
Amanda: [Deve perguntar período]

Você: "Manhã"
Amanda: [Deve oferecer horários, NÃO repetir pergunta]

✅ ESPERADO: Fluxo completo sem repetições
```

#### CENÁRIO 3: Não Repetir
```
Você: "Oi, meu filho tem 7 anos"
Amanda: [Responde]

Você: "Quanto custa?"
Amanda: [Deve dar preço, NÃO perguntar idade de novo]

✅ ESPERADO: Nenhuma menção a "idade" na 2ª resposta
```

#### CENÁRIO 4: Endereço
```
Você: "Onde fica a clínica?"

✅ ESPERADO:
- Endereço completo
- Retomar coleta se necessário
```

#### CENÁRIO 5: Convênio
```
Você: "Vocês aceitam Unimed?"

✅ ESPERADO:
- Explicar que é particular
- Retomar coleta
```

---

## 📊 MONITORAMENTO PÓS-DEPLOY

### Métricas Críticas (primeiras 2 horas)

```bash
# Erros por minuto
tail -f logs/app.log | grep ERROR | wc -l

# Respostas repetidas (sinal de problema)
tail -f logs/app.log | grep "qual a idade" | wc -l

# Tempo de resposta
tail -f logs/app.log | grep "handlerTimeMs"
```

### Alertas para Rollback Imediato

🚨 **FAÇA ROLLBACK SE:**
- [ ] Erro em mais de 5% das mensagens
- [ ] Amanda entrando em loop (repetindo mesma pergunta)
- [ ] Tempo de resposta > 10 segundos
- [ ] Leads reclamando de respostas estranhas
- [ ] Mensagens não sendo enviadas

---

## 🔧 COMO FAZER ROLLBACK

### Opção 1: Desabilitar via Feature Flag (30 segundos)
```bash
# Painel da hospedagem
NEW_ORCHESTRATOR=false

# Aplicar mudança
# Pronto! Amanda volta para versão antiga
```

### Opção 2: Reverter Commit (2 minutos)
```bash
# Local
git revert HEAD
git push origin main

# Deploy automático deve acontecer
```

### Opção 3: Restore de Backup (5 minutos)
```bash
# Se tiver backup da versão anterior
render deploy --backup-id=xxx
```

---

## 📱 TEMPLATE DE COMUNICAÇÃO

### Para equipe (Slack/WhatsApp)
```
🚨 DEPLOY AMANDA - [DATA/HORA]

Status: ✅ CONCLUÍDO / ❌ ROLLBACK
Versão: v2.3.0
Mudanças principais:
- Novo fluxo de qualificação
- Correção de repetição de perguntas
- Logs estruturados

Testes:
- [ ] 7/7 automatizados passando
- [ ] Teste manual OK
- [ ] Monitoramento ativo

Em caso de problema, rollback: 
https://dashboard.render.com/...
```

---

## 🎯 VALIDAÇÃO FINAL (24h após deploy)

### Checklist de 24 horas

- [ ] Nenhum erro crítico nos logs
- [ ] Taxa de conversão mantida (ou melhorada)
- [ ] Tempo médio de resposta < 3s
- [ ] Nenhum lead "travado" em loop
- [ ] Feedbacks positivos da equipe

### Métricas para comparar

| Métrica | Antes | Depois | Status |
|---------|-------|--------|--------|
| Erros/dia | X | Y | ✅/❌ |
| Tempo resposta | Xs | Ys | ✅/❌ |
| Leads qualificados | X% | Y% | ✅/❌ |
| Reclamações | X | Y | ✅/❌ |

---

## 🆘 EMERGÊNCIA: Amanda com problema

### Passo 1: Identifique o sintoma
```
❌ Sintoma: Loop infinito
   → Amanda pergunta mesma coisa repetidamente
   
❌ Sintoma: Silêncio
   → Amanda não responde
   
❌ Sintoma: Respostas estranhas
   → Texto não faz sentido
```

### Passo 2: Verifique logs
```bash
# Últimos erros
tail -100 logs/app.log | grep ERROR

# Logs específicos do lead problemático
tail -1000 logs/app.log | grep "LEAD_ID_AQUI"
```

### Passo 3: Ação imediata
```bash
# Se loop ou silêncio: DESATIVE AUTO-REPLY
curl -X POST https://sua-api.com/admin/disable-auto-reply

# Ou faça rollback completo
NEW_ORCHESTRATOR=false
```

### Passo 4: Comunique
```
🚨 PROBLEMA EM PRODUÇÃO

Sintoma: [descrição]
Horário: [hora]
Leads afetados: [estimativa]
Ação tomada: [rollback/desabilitado]

Investigando...
```

---

## ✅ RESUMO DO PROCESSO

```
1. TESTES LOCAIS
   └── npm test (7/7 passando)
   
2. DEPLOY SEGURO
   ├── Feature flag DESLIGADA
   ├── Testa seu número
   ├── Ativa gradualmente
   
3. MONITORAMENTO
   ├── 2h: Alertas em tempo real
   ├── 24h: Métricas consolidadas
   └── 7 dias: Análise completa
   
4. ROLLBACK (se necessário)
   └── NEW_ORCHESTRATOR=false (30s)
```

---

**Documento mantido por:** Equipe de Dev  
**Última atualização:** 03/02/2026  
**Versão:** 1.0
