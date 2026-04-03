# GUIA PABLO - Billing V2

> Rápido e direto. Sem teoria.

---

## COMANDOS ESSENCIAIS

```bash
# Ver se está tudo OK
npm run billing:status
npm run billing:validate

# Subir V2 (fazer na ordem!)
npm run billing:go-live worker      # 1. Sempre primeiro
npm run billing:go-live create      # 2. Testar no front
npm run billing:go-live billed      # 3. Depois de validar
npm run billing:go-live received    # 4. Último

# Se der merda
npm run billing:rollback
```

---

## ORDEM PARA SUBIR

### 1. Worker (obrigatório primeiro)
```bash
npm run billing:go-live worker
```
Verificar: `pm2 list` → deve aparecer online

### 2. Create (testar no front!)
```bash
npm run billing:go-live create
```
**Testar:**
- Criar agendamento convênio
- Completar sessão
- Verificar se criou 1 appointment e 1 payment
- **CRÍTICO:** Confirmar que NÃO duplicou

### 3. Billed
```bash
npm run billing:go-live billed
```
**Testar:** Botão "Faturar" funciona no front

### 4. Received
```bash
npm run billing:go-live received
```
**Testar:** Botão "Receber" funciona no front

---

## O QUE VERIFICAR NO FRONT

### Etapa Create
✅ Agendamento criado  
✅ Sessão completada → Appointment criado automatico  
✅ Payment criado (status: "pending_billing")  
✅ Guia consumiu 1 sessão  
❌ NÃO pode ter duplicata (2 payments)

### Etapa Billed
✅ Botão "Faturar" muda status para "Faturado"

### Etapa Received
✅ Botão "Receber" muda status para "Pago"

---

## ALERTAS - ROLLBACK IMEDIATO

Se ver qualquer um desses:
```bash
npm run billing:rollback
```

- ❌ 2 payments para mesma sessão
- ❌ Status não muda ao clicar botão
- ❌ Erro no console do navegador
- ❌ `npm run billing:validate` mostra erro

---

## MONITORAMENTO

```bash
# Deixar rodando em 1 terminal
npm run billing:monitor
```

**Deve mostrar:**
- Taxa de sucesso: 100%
- Duplicatas: 0
- DLQ: 0

Se DLQ > 0 → investigar

---

## CHECKLIST ANTES DE CADA ETAPA

- [ ] `npm run billing:validate` passou
- [ ] Frontend carregou sem erro
- [ ] Tenho como fazer rollback se der errado

---

## EMERGÊNCIA

```bash
# Desativa TUDO do V2 (volta pro legado)
npm run billing:rollback

# Verificar se parou
npm run billing:status
```

---

## CONTATO

Se travar: [seu-contato]

**Regra de ouro:** Se não tiver certeza, não sobe. Valida primeiro.
