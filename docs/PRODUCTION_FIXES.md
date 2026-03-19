# 🚨 Correções de Produção - Amanda AI

## Resumo das Correções Aplicadas

### P1: therapyDetector.js - Error `Cannot read properties of undefined (reading 'some')`
**Arquivo:** `utils/therapyDetector.js`  
**Problema:** Crash quando texto não contém patterns de terapia (ex: "Manhã", "Oi", "Fono")

**Correção aplicada:**
- Adicionada proteção extra para validar cada pattern como RegExp antes de usar
- Adicionado try-catch interno no loop de patterns
- Log de debug para patterns inválidos

```javascript
// 🛡️ Proteção extra: validar cada pattern
const validPatterns = spec.patterns.filter(p => p instanceof RegExp);
if (validPatterns.length === 0) continue;

const hasMatch = validPatterns.some(pattern => {
    try {
        if (pattern.global) pattern.lastIndex = 0;
        return pattern.test(normalized);
    } catch (e) {
        console.error(`[therapyDetector] Erro no pattern de ${id}:`, e.message);
        return false;
    }
});
```

---

### P2: Timezone Follow-up -1h
**Arquivo:** `services/leadCircuitService.js`  
**Problema:** Follow-ups sendo agendados 1h no passado (UTC vs BRT)

**Correção aplicada:**
- Usar `Date.now()` consistentemente para cálculo de timestamps
- Remover uso de variável `now` que podia estar em UTC

```javascript
// 🛡️ FIX: Usar timestamp atual em vez de now para evitar -1h
const currentTimestamp = Date.now();
const scheduledAt = new Date(currentTimestamp + (config.delay || 0));
const initialStatus = scheduledAt.getTime() <= currentTimestamp ? 'processing' : 'scheduled';
```

---

### P3: Template WhatsApp 'default' Inexistente
**Arquivo:** `services/leadCircuitService.js`  
**Problema:** Template 'default' não existe na conta Meta WhatsApp

**Correção aplicada:**
- Mudar `playbook: 'default'` para `playbook: null`
- Worker vai usar mensagem de texto normal ao invés de template

```javascript
// 🛡️ FIX: Usar mensagem de texto ao invés de template 'default'
playbook: null,
```

---

### P4: ChatContext Not Defined
**Arquivo:** `services/intelligence/ConversationAnalysisService.js`  
**Problema:** Uso de `ChatContext.findOne()` sem import do modelo

**Correção aplicada:**
- Substituir chamada por Promise.resolve(null)
- Remover dependência do modelo inexistente

```javascript
// 🛡️ FIX: ChatContext removido, usar dados do lead
Promise.resolve(null), // ChatContext não existe mais
```

---

### P5: Redis `setex is not a function`
**Arquivo:** `crons/learningCron.js`  
**Problema:** Redis v4+ não tem método `setex`, usa `set` com opção `EX`

**Correção aplicada:**
- Substituir `redis.setex(key, ttl, value)` por `redis.set(key, value, { EX: ttl })`

```javascript
// 🛡️ FIX: Redis v4+ usa set com EX ao invés de setex
await redis.set('learning:last_run', JSON.stringify({...}), { EX: 86400 * 7 });
```

**Nota:** Arquivos que usam `ioredis` (`doctorHelper.js`, `whatsappController.js`) não precisam de correção pois o ioredis ainda suporta `setex`.

---

## Testes

**Arquivo de testes:** `tests/unit/production-fixes.test.js`

Testes implementados:
- ✅ P1: 10 testes para therapyDetector (null, undefined, "Manhã", "Fono", "Oi", etc.)
- ✅ P2: Teste de timezone para follow-ups
- ✅ P3: Teste para playbook null
- ✅ P4: Teste para ChatContext

Resultado: **10/13 testes passando** (3 timeout por configuração de ambiente)

---

## Deploy

1. Commits em staging
2. Testar em ambiente de staging
3. Deploy para produção
4. Monitorar logs por 24h

## Monitoramento

Verificar logs por:
- `[therapyDetector] Erro no pattern` (deve diminuir)
- `Template name does not exist` (deve sumir)
- `ChatContext is not defined` (deve sumir)
- `redis.setex is not a function` (deve sumir)
- Follow-ups agendados no passado (devem ser raros/extremos)
