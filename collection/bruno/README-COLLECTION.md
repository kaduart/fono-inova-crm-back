# 📁 Estrutura da Collection Bruno - CRM 4.0

Organização dos endpoints de teste por domínio.

---

## 📂 Pastas

### `/particular`
Endpoints para agendamentos particulares (pagamento direto).

| Arquivo | Descrição |
|---------|-----------|
| `Create Particular.bru` | Cria agendamento particular (pix, dinheiro, cartão) |

**Fluxo:** Create → Check Status → Complete → (Payment criado automaticamente)

---

### `/package`
Endpoints para sessões de pacote (pré-pago ou per-session).

| Arquivo | Descrição |
|---------|-----------|
| `Create Package Session.bru` | Cria sessão de pacote com reaproveitamento de crédito |

**Fluxo:** Create → (reaproveita crédito cancelado se existir) → Check Status → Complete

**Regras:**
- Pacote pré-pago: Não cria Payment
- Pacote per-session: Cria Payment no complete

---

### `/convenio`
Endpoints para agendamentos de convênio médico.

| Arquivo | Descrição |
|---------|-----------|
| `Create Convenio.bru` | Cria agendamento com guia de convênio |

**Fluxo:** Create → Check Status → Complete → (consome guia)

**Regras:**
- Valida se guia tem sessões disponíveis
- Cria Payment tipo 'convenio' (recebimento futuro)

---

### `/liminar`
Endpoints para sessões judiciais (liminar).

| Arquivo | Descrição |
|---------|-----------|
| `Create Liminar.bru` | Cria agendamento judicial |

**Fluxo:** Create → Check Status → Complete → (reconhece receita)

**Regras:**
- Reconhecimento de receita judicial
- Atualiza liminarCreditBalance

---

### `/core`
Endpoints comuns a todos os tipos de agendamento.

| Arquivo | Descrição |
|---------|-----------|
| `Check Status.bru` | Polling de status (processing → scheduled → confirmed) |
| `Get Appointment Full.bru` | Busca dados completos populados |
| `Complete Session.bru` | Finaliza sessão (atualiza pacote/guia) |
| `Complete with Balance.bru` | Finaliza com fiado (addToBalance) |
| `Cancel Appointment.bru` | Cancela e preserva dados |
| `List with Filters.bru` | Lista agendamentos com filtros |

---

### `/auth`
Autenticação e geração de tokens.

| Arquivo | Descrição |
|---------|-----------|
| `Login.bru` | Gera token JWT e salva automaticamente no environment |

**Uso:**
1. Configure `loginEmail`, `loginPassword` e `loginRole` no environment
2. Execute `auth/Login`
3. Token será salvo automaticamente em `{{token}}`

---

### `/debug`
Ferramentas de debug e manutenção.

| Arquivo | Descrição |
|---------|-----------|
| `Debug - Queue Status.bru` | Verifica status das filas BullMQ |
| `Debug - Process Manual.bru` | Processa agendamento manualmente |
| `Debug - Complete Manual.bru` | Completa agendamento manualmente |
| `Reprocessar Evento (DLQ).bru` | Reprocessa eventos da Dead Letter Queue |
| `Hardening - Test All.bru` | Health check completo |

---

### `/payment`
Endpoints relacionados a pagamentos.

| Arquivo | Descrição |
|---------|-----------|
| `Get Payment.bru` | Busca detalhes do pagamento |

---

### `/session`
Endpoints relacionados a sessões.

| Arquivo | Descrição |
|---------|-----------|
| `Get Session.bru` | Busca detalhes da sessão |

---

## 🎯 Fluxo de Teste por Tipo

### Particular
```
1. particular/Create Particular
2. core/Check Status (até scheduled)
3. core/Complete Session
4. core/Check Status (até confirmed)
```

### Pacote
```
1. package/Create Package Session
2. core/Check Status (até scheduled)
3. core/Complete Session
4. core/Check Status (até confirmed)
```

### Convênio
```
1. convenio/Create Convenio
2. core/Check Status (até scheduled)
3. core/Complete Session (consome guia)
4. core/Check Status (até confirmed)
```

### Liminar
```
1. liminar/Create Liminar
2. core/Check Status (até scheduled)
3. core/Complete Session (reconhece receita)
4. core/Check Status (até confirmed)
```

---

## ⚠️ Variáveis de Environment Necessárias

### Obrigatórias
```
baseUrl=http://localhost:5000/api
```

### Autenticação (para endpoint `/auth/Login`)
```
loginEmail=seu@email.com
loginPassword=sua_senha
loginRole=admin | doctor | user
```

### Opcionais (previamente preenchidas)
```
token=JWT_TOKEN_AQUI          # Será preenchido automaticamente pelo Login
patientId=ID_PACIENTE_TESTE
doctorId=ID_PROFISSIONAL_TESTE
packageId=ID_PACOTE_TESTE
insuranceGuideId=ID_GUIA_CONVENIO_TESTE
liminarPackageId=ID_PACOTE_LIMINAR_TESTE
```

---

## 🧪 Script de Teste Rápido

```bash
# Testa todos os fluxos
cd back/collection/bruno

# 1. Autenticação (obrigatório primeiro)
bruno auth/Login.bru

# 2. Particular
bruno particular/Create\ Particular.bru
bruno core/Check\ Status.bru
bruno core/Complete\ Session.bru

# 3. Pacote  
bruno package/Create\ Package\ Session.bru
bruno core/Check\ Status.bru

# 4. Convênio
bruno convenio/Create\ Convenio.bru
bruno core/Check\ Status.bru

# 5. Liminar
bruno liminar/Create\ Liminar.bru
bruno core/Check\ Status.bru
```
