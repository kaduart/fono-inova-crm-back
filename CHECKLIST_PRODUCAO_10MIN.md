# ✅ Checklist Final de Produção - V2

**Tempo:** 10 minutos | **Objetivo:** Validar V2 ponta a ponta

---

## 🎯 Teste 1: Create Package (2 min)

### Ação:
1. Acesse paciente → Criar Pacote
2. Preencha:
   - Tipo: Therapy (Particular)
   - Sessões: 4
   - Valor: R$ 100,00
   - Datas: Selecione 4 horários (incluindo um feriado para testar skip)

### ✅ Validação:
- [ ] Pacote criado sem erro
- [ ] Mensagem: "Pacote criado com X agendamentos"
- [ ] Se feriado: mensagem "Feriados ajustados: [nome]"
- [ ] Lista atualiza automaticamente (sem F5)

---

## 🎯 Teste 2: Ver Sessões (1 min)

### Ação:
1. Abra o pacote criado
2. Clique em "Sessões do Pacote"

### ✅ Validação:
- [ ] Mostra "4 sessões" (não 0)
- [ ] Horários aparecem corretos
- [ ] Status: "scheduled"

---

## 🎯 Teste 3: Complete Session (3 min)

### Ação:
1. Vá para Agenda
2. Encontre a primeira sessão do pacote
3. Clique "Completar"
4. Confirme

### ✅ Validação:
- [ ] Status muda para "completed"
- [ ] Balance atualiza (se particular)
- [ ] sessionsDone: 1/4
- [ ] Não dá erro de idempotência se clicar 2x

---

## 🎯 Teste 4: Cancelamento (2 min)

### Ação:
1. Crie novo pacote (convenio ou liminar)
2. Tente cancelar uma sessão "scheduled"

### ✅ Validação:
- [ ] Cancela com sucesso
- [ ] Status: "canceled"
- [ ] Se liminar: crédito restaura
- [ ] Se convenio: não altera financeiro

---

## 🎯 Teste 5: Package Convênio (2 min)

### Ação:
1. Crie pacote tipo "Convênio"
2. Selecione guia
3. Complete sessão

### ✅ Validação:
- [ ] Cria sem erro
- [ ] sessionValue: 0
- [ ] Completa sem cobrança
- [ ] Status: "completed"

---

## 🚨 Se Algum Falhar

| Falha | Ação |
|-------|------|
| "INVALID_TYPE" | Verificar se `type` está no payload |
| "sessions": 0 | Verificar se `schedule` foi enviado |
| "HOLIDAY_BLOCKED" | OK - feriado pulou automaticamente |
| Lista não atualiza | Verificar React Query invalidate |
| Balance não muda | Verificar billingType no package |

---

## 🎉 Se Todos Passarem

```
┌─────────────────────────────────────────┐
│                                         │
│   ✅ SISTEMA V2 PRONTO PARA PRODUÇÃO    │
│                                         │
│   - Financeiro: OK                      │
│   - Agenda: OK                          │
│   - Cancel/Complete: OK                 │
│   - Convênio/Liminar: OK                │
│                                         │
└─────────────────────────────────────────┘
```

---

## 🚀 Deploy Aprovado

**Data:** ___________  
**Assinatura:** ___________  
**Hora:** ___________

---

💀 **Pronto para produção!**
