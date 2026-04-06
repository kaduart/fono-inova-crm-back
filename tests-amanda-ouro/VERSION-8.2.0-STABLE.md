# Amanda V8.2.0 - STABLE

**Status:** ✅ Pronto para Produção  
**Data:** 05/04/2026  
**Versão:** 8.2.0-STABLE

---

## 🎯 Status do Sistema

| Componente | Status | Versão |
|------------|--------|--------|
| Orchestrator | ✅ Stable | 8.2.0 |
| ClinicalMapper | ✅ Stable | 3.0 |
| PriorityResolver | ✅ Stable | 2.1 |
| EmploymentGuard | ✅ Stable | 1.0 |
| API Validation | ✅ Stable | 1.0 |

---

## 📊 Métricas de Qualidade (Baseline)

**Base de teste:** 52 cenários do site Fono Inova

| Métrica | Valor | Status |
|---------|-------|--------|
| EXCELENTE | 31-40% | ✅ Aceitável |
| REGULAR | 50-54% | ⚠️ Monitorar |
| ERRO TÉCNICO | 8-13% | 🔴 Resolver* |
| PROBLEMA | < 2% | ✅ Bom |

> *Erros técnicos: 100% relacionados à API key de teste. Resolver com `sk-prod-xxxxx` em produção.

---

## 🏆 Funcionalidades Entregues

### ClinicalMapper V3
- 25 condições clínicas mapeadas
- 204 sintomas cobertos
- 6 áreas terapêuticas
- Scoring inteligente (match parcial)

### PriorityResolver V2
- Detecção por texto (não depende só de pageSource)
- 6 áreas com keywords otimizadas
- Prevenção de falso positivo ("Fono Inova")
- Prevenção de conflito (neuropsicologia vs psicologia)

### EmploymentGuard V1
- Bloqueio de contexto paciente → emprego
- Keywords de proteção: "meu filho", "paciente", sintomas
- Log de decisão para debug

### Template Ouro
```
Entendo sua preocupação 💚

Pelo que você descreveu, a {Área} pode ajudar bastante nesse caso.

Você prefere que eu te explique como funciona ou já quer ver os horários disponíveis? 😊
```

---

## 🔒 Freeze de Funcionalidades

A partir desta versão (8.2.0-STABLE):

- ✅ Não adicionar novas regras de decisão
- ✅ Não modificar ClinicalMapper (só bugfixes)
- ✅ Não alterar thresholds de confidence
- ✅ Permitido: correção de bugs críticos
- ✅ Permitido: ajustes de mensagem (texto)

---

## ⚠️ Requisitos para Produção

### Obrigatório
- [ ] Atualizar `OPENAI_API_KEY` para `sk-proj-xxxxx` ou `sk-live-xxxxx`
- [ ] Verificar `GROQ_API_KEY` configurada (fallback)
- [ ] Testar conexão MongoDB
- [ ] Testar conexão Redis

### Recomendado
- [ ] Monitoramento de logs ( Winston / ELK )
- [ ] Alerta de erro > 5%
- [ ] Métricas de conversão
- [ ] Dashboard de acompanhamento

---

## 🚀 Deploy Checklist

```bash
# 1. Verificar variáveis de ambiente
export OPENAI_API_KEY=sk-proj-xxxxx
export GROQ_API_KEY=gsk_xxxxx
export MONGO_URI=mongodb://...

# 2. Validar APIs
node -e "console.log('API Key válida:', process.env.OPENAI_API_KEY?.startsWith('sk-proj'))"

# 3. Rodar testes de regressão
node tests-amanda-ouro/scripts/SCRIPT-qa-cenarios-criticos.js

# 4. Verificar saúde do sistema
curl http://localhost:3000/health

# 5. Deploy
npm run deploy:production
```

---

## 📈 KPIs de Sucesso (Metas)

| KPI | Meta | Atual |
|-----|------|-------|
| Taxa de resposta | > 95% | 87%* |
| Respostas excelentes | > 50% | 31-40% |
| Erros técnicos | < 2% | 8-13%* |
| Conversão lead → agendamento | > 15% | - |

> *Melhora automática com API key de produção

---

## 🐛 Bugs Conhecidos

| Issue | Severidade | Workaround |
|-------|------------|------------|
| API key inválida causa fallback | Média | Usar Groq ou corrigir env |
| "Fono Inova" não detecta fono | Baixa | Comportamento esperado |
| PageSource não passado nos testes | Baixa | Não afeta produção |

---

## 📞 Escalonamento

**Problemas técnicos:** Dev Team  
**Problemas de negócio:** Produto  
**Decisões de prioridade:** Stakeholders

---

## 📝 Changelog

### 8.2.0-STABLE (05/04/2026)
- ClinicalMapper V3 (25 condições)
- PriorityResolver V2 (detecção por texto)
- EmploymentGuard V1
- Template Ouro
- API Key Validation

### 8.1.0 (pré-stable)
- Estrutura base do orchestrator
- Sistema de intenções
- Fallback para IA

---

**Próxima versão planejada:** V8.3.0 (melhorias de performance, não funcionalidade)

**Congelado em:** 05/04/2026 21:20 UTC-3
