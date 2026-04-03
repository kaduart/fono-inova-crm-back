# FLUXO DE TELAS - TESTE V2

```
┌─────────────────────────────────────────────────────────────────┐
│                     FLUXO DE TESTE NA VERA                      │
└─────────────────────────────────────────────────────────────────┘

[TELA 1] AGENDAMENTO
├─ Selecionar paciente
├─ Selecionar guia (com saldo)
└─ Clicar "Agendar"

   ↓ Verificar: Agendamento criado
   ↓ Verificar: Guia NÃO consumida ainda


[TELA 2] SESSÕES / ATENDIMENTOS
├─ Localizar sessão recém-criada
├─ Status: "Agendada" → Clicar "Completar"
└─ Confirmar

   ↓ Aguardar 5-10 segundos (V2 processando)
   
   Verificar:
   ├─ Status: "Completada"
   ├─ Appointment criado automaticamente
   ├─ Payment criado (status: "pending_billing")
   └─ Guia consumida (saldo -1)

   ⚠️ CRÍTICO: Verificar duplicatas
   ├─ Deve ter APENAS 1 Appointment
   └─ Deve ter APENAS 1 Payment


[TELA 3] FATURAMENTO / CONVÊNIOS
├─ Buscar sessão
├─ Status: "Aguardando faturamento"
├─ Clicar "Faturar"
├─ Preencher: Valor, Nota Fiscal
└─ Confirmar

   ↓ Verificar:
   ├─ Status mudou para "Faturado"
   ├─ Valor aparece preenchido
   └─ Data de faturamento registrada


[TELA 4] RECEBIMENTO
├─ Buscar sessão
├─ Status: "Faturado"
├─ Clicar "Receber"
├─ Preencher: Valor recebido, Data
└─ Confirmar

   ↓ Verificar:
   ├─ Status mudou para "Pago"
   ├─ Valor final confirmado
   ├─ Sessão marcada como "Paga" (verde)
   └─ Ciclo fechado


[TELA 5] RELATÓRIOS (validação final)
├─ Ir em "Relatórios > Financeiro"
├─ Filtrar período do teste
└─ Verificar:
   ├─ Valor faturado = 150.00
   ├─ Valor recebido = 140.00
   └─ Status: "Concluído"
```

---

## CHECKLIST VISUAL POR TELA

### ✅ TELA 1 - Agendamento
- [ ] Guia selecionada mostra saldo correto
- [ ] Ao salvar, volta para lista sem erro
- [ ] Agendamento aparece na lista

### ✅ TELA 2 - Sessões (MAIS IMPORTANTE)
- [ ] Botão "Completar" funciona
- [ ] Após completar, aparece loading breve
- [ ] **Appointment criado automaticamente**
- [ ] **Payment criado com status correto**
- [ ] **Guia consumiu 1 sessão**
- [ ] **NÃO criou duplicata**

### ✅ TELA 3 - Faturamento
- [ ] Sessão aparece em "A faturar"
- [ ] Botão "Faturar" abre modal
- [ ] Ao salvar, status muda para "Faturado"
- [ ] Valor persistiu

### ✅ TELA 4 - Recebimento
- [ ] Sessão aparece em "A receber"
- [ ] Botão "Receber" funciona
- [ ] Ao salvar, status muda para "Pago"
- [ ] Tudo fica verde/confirmação

---

## COMANDOS PARA RODAR ENQUANTO TESTA

```bash
# Terminal 1 - Status em tempo real
watch -n 5 npm run billing:status

# Terminal 2 - Validar
npm run billing:validate

# Terminal 3 - Rollback (se necessário)
npm run billing:rollback
```

---

## ERROS COMUNS NO FRONT

| Sintoma | Causa provável | Solução |
|---------|---------------|---------|
| Sessão completou mas não criou appointment | Worker não rodando | `npm run billing:go-live worker` |
| Criou 2 appointments | Race condition / duplicata | ROLLBACK + investigar |
| Status não muda | Evento não processado | Verificar fila: `npm run billing:status` |
| Erro "Payment not found" | Ordem errada (billed antes de create) | Verificar flags ativas |
| Valor zerado | V2 não preencheu | Verificar `processSessionCompleted` |

---

## VALIDAÇÃO FINAL (APÓS TODAS AS ETAPAS)

```bash
# 1. No banco, verificar consistência
mongosh crm --eval "
const s = db.sessions.findOne({/* sua query */});
const p = db.payments.findOne({session: s._id});
const a = db.appointments.findOne({'source.sessionId': s._id});

print('Session status:', s.status);
print('Session isPaid:', s.isPaid);
print('Payment status:', p.status);
print('Appointment status:', a.paymentStatus);
print('Guia consumida:', db.insuranceguides.findOne({_id: s.insuranceGuide}).usedSessions);
"

# 2. Esperado:
# Session status: completed
# Session isPaid: true
# Payment status: paid
# Appointment status: paid
# Guia consumida: 1
```

Tudo bateu? ✅ V2 está pronto!
