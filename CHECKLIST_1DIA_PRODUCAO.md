# ✅ Checklist 1 Dia - Zero Erro de Produção

**Data:** ___________ | **Responsável:** ___________

> 🎯 Objetivo: Estabilizar e entregar sem susto. Não adicionar features.

---

## 🌅 MANHÃ (4h) - Documentação & Preparação

### ☑️ 1. API Contract Final (1h)
- [ ] Revisar `API_CONTRACT_V2.md` com time frontend
- [ ] Confirmar todos endpoints V2 listados
- [ ] Validar payloads de entrada/saída
- [ ] Documentar códigos de erro específicos

**Entrega:** Frontend tem doc para copiar/colar

---

### ☑️ 2. Frontend DTO Helper (1.5h)
Criar no frontend:

```typescript
// utils/dtoHelper.ts - OBRIGATÓRIO
export function extractData<T>(response: any): T {
  const dto = response.data;
  
  // Se já for V1 (não tem wrapper), retorna direto
  if (!dto || typeof dto.success !== 'boolean') {
    return dto as T;
  }
  
  // V2: extrai de dto.data
  if (dto.success) {
    return dto.data as T;
  }
  
  throw new Error(dto.error?.message || 'Erro desconhecido');
}

export function isV2Response(response: any): boolean {
  return response?.data?.meta?.version === 'v2';
}
```

- [ ] Helper implementado
- [ ] Testado em 1 endpoint
- [ ] Time frontend treinado

**Entrega:** Frontend lida com V1/V2 automaticamente

---

### ☑️ 3. Revisão de Flags (30min)
Verificar `appointmentService.ts`:

```typescript
// Deve estar assim:
USE_V2_CREATE: true,    // ✅
USE_V2_COMPLETE: true,  // ✅
USE_V2_CANCEL: true,    // ✅
USE_V2_GET_BY_ID: true, // ✅
```

- [ ] Todas flags V2 = true
- [ ] Nenhum endpoint legacy sendo usado
- [ ] Console.logs removidos

**Entrega:** Frontend 100% V2

---

### ☑️ 4. Loading States (1h)
Adicionar em componentes críticos:

```typescript
// Async operations (202 Accepted)
const [isProcessing, setIsProcessing] = useState(false);

// No submit:
setIsProcessing(true);
const result = await appointmentService.create(data);
if (result.status === 'pending') {
  await pollStatus(result.appointmentId);
}
setIsProcessing(false);
```

- [ ] Create Appointment: loading + polling
- [ ] Complete: loading + validação DTO
- [ ] Cancel: loading + status 202

**Entrega:** Usuário vê feedback em toda operação

---

## 🌞 TARDE (4h) - Staging & Testes Reais

### ☑️ 5. Staging Deploy (1h)
```bash
# 1. Backup
mongodump --uri="$MONGO_STAGING_URI" --out=backup-staging-$(date +%Y%m%d)

# 2. Deploy
git checkout main
git pull origin main
npm ci
pm2 restart ecosystem.config.cjs --env staging

# 3. Health check
curl http://staging.fonoinova.com/api/v2/health
```

- [ ] Deploy feito
- [ ] Health check: 200
- [ ] Logs sem erros

**Entrega:** Staging rodando V2

---

### ☑️ 6. Teste Manual Completo (2h)
Simular fluxo de usuário real:

| # | Ação | Esperado | Status |
|---|------|----------|--------|
| 1 | Login | Token + redirect | ⬜ |
| 2 | Criar paciente | 202 + polling | ⬜ |
| 3 | Criar agendamento | 201 + ID | ⬜ |
| 4 | Ver lista | Aparece na lista | ⬜ |
| 5 | Completar | 200 + DTO V2 | ⬜ |
| 6 | Ver detalhe | Status completed | ⬜ |
| 7 | Tentar cancelar | Erro 409 (blocked) | ⬜ |
| 8 | Criar package | Validação por tipo | ⬜ |
| 9 | Ver balance | R$ correto | ⬜ |

- [ ] Todos passos executados
- [ ] Print das telas salvas
- [ ] Bugs anotados

**Entrega:** Fluxo real validado

---

### ☑️ 7. Teste de Error Handling (1h)
Testar cenários de erro:

```typescript
// Cenários:
1. Token expirado → 401 → redirect login
2. Horário conflito → 409 → mensagem amigável
3. Campo obrigatório faltando → 400 → highlight campo
4. Cancelar completed → 409 → "Não é possível cancelar"
5. Retry complete → 200 idempotent → "Já estava completado"
```

- [ ] Todos cenários testados
- [ ] Mensagens de erro amigáveis
- [ ] Não trava a UI

**Entrega:** Erros são tratados gracefulmente

---

## 🌙 NOITE (2h) - Polir & Monitorar

### ☑️ 8. Logs & Observabilidade (1h)
Adicionar tracking mínimo:

```typescript
// Em cada chamada API V2
console.log('[API V2]', {
  endpoint,
  correlationId: response.data.meta?.correlationId,
  version: response.data.meta?.version,
  duration: Date.now() - startTime
});
```

- [ ] CorrelationId visível no DevTools
- [ ] Tempo de resposta logado
- [ ] Erros logados com contexto

**Entrega:** Consigo debugar em produção

---

### ☑️ 9. Rollback Test (30min)
```bash
# Testar se consigo voltar rapidamente
pm2 stop crm-api-staging
git checkout v1.9.0
pm2 start ecosystem.config.cjs --env staging

# Verificar se V1 ainda funciona
curl /api/appointments (deve funcionar)

# Voltar para V2
git checkout main
pm2 restart ecosystem.config.cjs --env staging
```

- [ ] Rollback testado
- [ ] Voltar para V2 funcionou
- [ ] Tempo de rollback < 2 minutos

**Entrega:** Posso voltar se der problema

---

### ☑️ 10. Go/No-Go Decision (30min)

**Critérios para subir produção:**

| Critério | Status |
|----------|--------|
| Testes manuais passaram | ⬜ SIM / ⬜ NÃO |
| Frontend sem erros console | ⬜ SIM / ⬜ NÃO |
| Backend logs limpos | ⬜ SIM / ⬜ NÃO |
| Rollback testado | ⬜ SIM / ⬜ NÃO |
| Time frontend aprovou | ⬜ SIM / ⬜ NÃO |

**Decisão:** ⬜ **GO** (subir prod) | ⬜ **NO-GO** (mais um dia)

**Assinatura:** ___________

---

## 🚨 Se Der Problema Durante o Dia

### Prioridade de Fix:
1. **Crash/500** → Pára tudo, fixa agora
2. **Dados errados** → Põe no TODO, não bloqueia
3. **UI feia** → Deixa para depois do deploy

### Contato:
- Slack: `#v2-deploy`
- Chamada: se crashar em staging

---

## 💀 Regras de Ouro (Não Quebrar)

1. **NÃO adiciona feature nova** → só estabiliza
2. **NÃO mexe em arquitetura** → só ajusta
3. **NÃO deploy sem testar rollback** → obrigatório
4. **NÃO fica depois das 20h** → descansa, amanhã continua

---

## ✅ Definition of Done

O dia termina quando:

- [ ] Frontend usa helper DTO V2
- [ ] Staging tem V2 rodando
- [ ] Fluxo manual passou sem bug crítico
- [ ] Rollback testado e funcionando
- [ ] Decisão GO/NO-GO registrada

---

> 💀 **Lembrete:** Um sistema estável é melhor que um sistema perfeito.
> Se staging está funcionando, você já venceu.

**Bora.**