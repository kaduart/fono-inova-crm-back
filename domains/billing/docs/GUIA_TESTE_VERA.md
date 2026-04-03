# GUIA DE TESTE NA VERA - Billing V2

> Testar V2 em produção (ou staging real) passo a passo

---

## 🎯 O QUE VOCÊ PRECISA VER NO FRONT

### 1. TELA DE AGENDAMENTO
- Guia selecionada mostra saldo correto
- Ao agendar, NÃO cria Payment ainda (só no V2)

### 2. TELA DE SESSÕES
- Sessão "completed" → deve criar Appointment + Payment automatico
- Status financeiro: "Aguardando faturamento"

### 3. TELA DE FATURAMENTO
- Botão "Faturar" → muda para "Faturado"
- Valor preenchido

### 4. TELA DE RECEBIMENTO
- Botão "Receber" → muda para "Pago"
- Valor final confirmado

---

## 📋 CHECKLIST POR ETAPA

### FASE 1: WORKER (5 min)

```bash
# 1. Subir worker
npm run billing:go-live worker

# 2. Verificar se está rodando
pm2 list
# ou
ps aux | grep billingConsumerWorker
```

**No front:**
- [ ] Nenhuma mudança ainda (worker só escuta)
- [ ] Console do navegador: sem erros de WS (se usar socket)

---

### FASE 2: CREATE (10 min)

```bash
# Ativar criação V2
npm run billing:go-live create

# Verificar se não quebrou nada
npm run billing:validate
```

**Teste no front:**

1. **Criar agendamento convênio**
   - Paciente: [nome teste]
   - Guia: selecionar guia com saldo
   - Salvar

2. **Verificar imediatamente:**
   - [ ] Agendamento aparece na lista
   - [ ] Status: "Agendado" (não "Faturado" ainda)
   - [ ] Guia NÃO foi consumida ainda (saldo intacto)

3. **Completar sessão**
   - Ir na sessão → marcar "Completada"
   - [ ] Status mudou para "Completada"
   - [ ] Loading/processando (V2 trabalhando)

4. **Aguardar 5-10 segundos**

5. **Verificar resultado V2:**
   - [ ] Appointment criado (ver em "Atendimentos")
   - [ ] Payment criado (ver em "Financeiro > Convênios")
   - [ ] Status: "Aguardando faturamento"
   - [ ] Guia consumida (saldo diminuiu em 1)

6. **Verificar DUPLICATA (CRÍTICO):**
   - [ ] Só existe 1 Appointment para essa sessão
   - [ ] Só existe 1 Payment para essa sessão
   - Se aparecer duplicado → ROLLBACK IMEDIATO

---

### FASE 3: BILLED (10 min)

```bash
npm run billing:go-live billed
```

**Teste no front:**

1. **Ir em "Faturamento"**
   - Buscar sessão teste
   - [ ] Status: "Aguardando faturamento"

2. **Clicar "Faturar"**
   - Preencher: Valor = 150.00, Nota fiscal = TEST-001
   - Confirmar

3. **Verificar:**
   - [ ] Status mudou para "Faturado"
   - [ ] Valor aparece: 150.00
   - [ ] Data de faturamento preenchida

4. **Verificar no Mongo (opcional):**
```bash
mongosh crm --eval "
db.payments.findOne(
  { 'insurance.authorizationCode': 'NUMERO_DA_GUIA_TESTE' },
  { status: 1, 'insurance.status': 1, amount: 1 }
)
"
# Deve retornar: status: 'billed'
```

---

### FASE 4: RECEIVED (10 min)

```bash
npm run billing:go-live received
```

**Teste no front:**

1. **Ir em "Recebimentos"**
   - Buscar sessão teste
   - [ ] Status: "Faturado"

2. **Clicar "Receber"**
   - Preencher: Valor recebido = 140.00, Data = hoje
   - Confirmar

3. **Verificar:**
   - [ ] Status mudou para "Pago"
   - [ ] Valor final: 140.00
   - [ ] Sessão marcada como "Paga"
   - [ ] Cor verde/ok no status

4. **Verificar consistência:**
   - [ ] Session → isPaid: true
   - [ ] Appointment → paymentStatus: 'paid'
   - [ ] Payment → status: 'paid'

---

## 🔍 COMANDOS PARA VALIDAR

### Durante o teste, rode em outro terminal:

```bash
# Monitorar em tempo real
npm run billing:monitor

# Deve mostrar:
# ✅ Taxa de sucesso: 100%
# ✅ Duplicatas: 0
# ✅ DLQ: 0
```

### Verificar no banco:

```bash
# Contar entidades criadas
mongosh crm --eval "
print('Sessions:', db.sessions.countDocuments({patient: ObjectId('ID_DO_PACIENTE')}));
print('Payments:', db.payments.countDocuments({patient: ObjectId('ID_DO_PACIENTE')}));
print('Appointments:', db.appointments.countDocuments({patient: ObjectId('ID_DO_PACIENTE')}));
"
```

Deve ser: 1, 1, 1 (não 1, 2, 2)

---

## 🚨 ROLLBACK DE EMERGÊNCIA

Se algo der errado no front:

```bash
# Imediatamente
npm run billing:rollback

# Verificar se parou
npm run billing:validate
```

**Sintomas de problema:**
- ❌ Duplicatas (2 payments para mesma sessão)
- ❌ Status não muda
- ❌ Guia consumiu mas não criou payment
- ❌ Valor zerado
- ❌ Erro no console do navegador

---

## ✅ CHECKLIST FINAL (APROVAÇÃO)

- [ ] Worker rodando sem erros
- [ ] Create: criou 1 appointment + 1 payment (sem duplicata)
- [ ] Billed: atualizou status + valor
- [ ] Received: fechou ciclo, tudo "paid"
- [ ] Reconciliação: 0 inconsistências
- [ ] Front responde rápido (não travou)
- [ ] Sem erros no console do navegador

**Se todos passarem:** V2 aprovado para uso geral

---

## 📱 COMANDOS RÁPIDOS (COPIAR/COLAR)

```bash
# 1. Preparar
npm run billing:validate

# 2. Subir V2
npm run billing:go-live worker
npm run billing:go-live create

# 3. Monitorar
npm run billing:monitor

# 4. Se der merda
npm run billing:rollback
```
