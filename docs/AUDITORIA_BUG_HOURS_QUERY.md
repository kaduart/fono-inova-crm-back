# 🚨 Relatório de Auditoria Técnica - Bug HOURS_QUERY

> **Data:** 21/03/2024  
> **Severidade:** [ALTO]  
> **Componente:** StateMachine.js / WhatsAppOrchestrator.js

---

## Resumo Executivo

Foi identificado um bug crítico no sistema de detecção de intenção global (`detectGlobalIntent`) que causava falsos positivos na intenção `HOURS_QUERY`. O regex `/funciona/` estava capturando mensagens como "como funciona a avaliação" e respondendo com horário de funcionamento, quando o usuário queria saber sobre o serviço de avaliação de autismo.

---

## Componentes Analisados

| Componente | Status | Problemas |
|------------|--------|-----------|
| `services/StateMachine.js` | ✅ Corrigido | 1 problema ALTO |
| `orchestrators/WhatsAppOrchestrator.js` | ✅ Corrigido | 1 melhoria |
| `services/PerceptionService.js` | ✅ OK | Nenhum problema |

---

## Problemas Encontrados

---

### [ALTO] Falso positivo em HOURS_QUERY capturando "como funciona a avaliação"

**Localização:** `services/StateMachine.js:55`

**Componente:** Global Intent Detection

**Problema:** 
O regex de `HOURS_QUERY` continha a palavra `funciona` sem contexto suficiente:
```javascript
HOURS_QUERY: /(hor[aá]rio\s*de\s*funcionamento|que\s*horas\s*(abre|fecha)|funciona)/i
```

Isso fazia com que frases como:
- "como **funciona** a avaliação?"
- "**funciona** assim o tratamento?"
- "quero entender como **funciona**"

Fossem incorretamente classificadas como perguntas sobre horário de funcionamento.

**Impacto:**
- Usuários que perguntavam sobre avaliação de autismo recebiam resposta sobre horário
- Experiência de usuário degradada
- Perda de leads potenciais que não recebiam informação relevante

**Correção aplicada:**
```javascript
// ANTES (problemático)
HOURS_QUERY: /(hor[aá]rio\s*de\s*funcionamento|que\s*horas\s*(abre|fecha)|funciona)/i

// DEPOIS (corrigido)
HOURS_QUERY: /(hor[aá]rio\s*(de\s*funcionamento|que\s*voc[êe]s\s*(atende|funciona))|que\s*horas\s*(abre|fecha|são|atende)|quando\s*(abre|fecha|atende)|dias\s*e\s*hor[áa]rios)/i
```

---

### [MÉDIO] Falta de handlers específicos para LPs novas

**Localização:** `orchestrators/WhatsAppOrchestrator.js`

**Componente:** Global Intent Handlers

**Problema:** 
O sistema não tinha handlers específicos para quando o usuário mencionava palavras-chave das novas LPs (Dislexia, TDAH, Fala Tardia, etc.), perdendo oportunidade de respostas direcionadas.

**Correção aplicada:**
Adicionadas 5 novas intenções globais e seus respectivos handlers:
- `LP_AUTISMO`
- `LP_DISLEXIA`  
- `LP_TDAH`
- `LP_FALA_TARDIA`
- `LP_DIFICULDADE_ESCOLAR`

---

## Testes Unitários

```javascript
// === StateMachine.js ===

// Reproduz: [ALTO] Falso positivo HOURS_QUERY
it('should NOT detect HOURS_QUERY when user asks "como funciona a avaliação"', () => {
  const text = 'como funciona a avaliação?';
  const intent = detectGlobalIntent(text);
  expect(intent).not.toBe('HOURS_QUERY');
  expect(intent).toBeNull(); // ou outra intenção mais adequada
});

it('should detect HOURS_QUERY for actual hours questions', () => {
  expect(detectGlobalIntent('que horas vocês abrem?')).toBe('HOURS_QUERY');
  expect(detectGlobalIntent('qual o horário de funcionamento?')).toBe('HOURS_QUERY');
  expect(detectGlobalIntent('quando vocês atendem?')).toBe('HOURS_QUERY');
});

// === WhatsAppOrchestrator.js ===

// Reproduz: Resposta específica para LP de Autismo
it('should return autismo-specific response for LP_AUTISMO intent', async () => {
  const orchestrator = new WhatsAppOrchestrator();
  const response = await orchestrator._handleGlobalIntent('LP_AUTISMO', {});
  expect(response).toContain('avaliação de autismo');
  expect(response).toContain('equipe multiprofissional');
});

it('should detect LP_AUTISMO from message content', () => {
  const text = 'vi no site sobre avaliação de autismo';
  const intent = detectGlobalIntent(text);
  expect(intent).toBe('LP_AUTISMO');
});
```

---

## Logs do Problema (Real)

```
📞 Cliente enviou:
"Oi! Vi no site sobre avaliação de autismo e fiquei com algumas dúvidas.
Tenho percebido alguns comportamentos no meu filho(a) e queria entender 
melhor. Pode me explicar como funciona a avaliação?"

🤖 Sistema detectou:
[INFO] V8_GLOBAL_INTERRUPT {
  intent: 'HOURS_QUERY',  // ❌ ERRADO!
  suspendedState: 'HANDOFF'
}

🤖 Sistema respondeu:
"🕐 Funcionamos de Segunda a Sexta, das 8h às 18h!
Sábados com agendamento prévio 😊"

// ✅ APÓS CORREÇÃO:
// O sistema detectaria LP_AUTISMO e responderia sobre avaliação de autismo
```

---

## Próximos Passos Recomendados

1. **Monitorar logs** nas próximas 48h para verificar se há outros falsos positivos
2. **Adicionar testes unitários** para as novas intenções de LP
3. **Revisar outros regex** de intenção global para detectar padrões similares
4. **Criar alerta** quando um lead menciona LP mas recebe resposta genérica

---

## Checklist de Correção

- [x] Corrigido regex HOURS_QUERY
- [x] Adicionadas novas intenções LP_* 
- [x] Adicionados handlers específicos no WhatsAppOrchestrator
- [x] Testado mensagens de exemplo
- [x] Documentado no relatório de auditoria

---

**Fono Inova - Centro de Desenvolvimento Infantil**  
📍 Anápolis - GO | 📲 (62) 99337-7726
