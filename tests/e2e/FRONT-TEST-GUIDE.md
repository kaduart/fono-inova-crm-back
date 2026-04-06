# 🎨 Guia de Teste pelo Front-End

## Resumo dos Fluxos V2

| Fluxo | Tipo | Quem Paga | Teste E2E | Bruno Collection |
|-------|------|-----------|-----------|------------------|
| **Particular** | Sessão avulsa | Paciente | `npm run test:e2e:package` | `core/Create Particular` |
| **Package** | Pacote therapy | Paciente (pré-pago) | `npm run test:e2e:package` | `pacotes/package/*` |
| **Convênio** | Guia autorizada | Convênio | `npm run test:e2e:convenio` | `pacotes/convenio/*` |
| **Liminar** | Pacote judicial | Governo | `npm run test:e2e:liminar` | `pacotes/liminar/*` |

---

## 🧪 Como Testar pelo Front

### 1. PARTICULAR (Básico)

**Fluxo:**
```
POST /v2/appointments (particular)
  ↓
PATCH /v2/appointments/:id/complete
  ↓
Payment criado automaticamente
```

**Teste:**
```bash
npm run test:e2e:package
```

**Validação Front:**
- Status vai para `completed`
- `paymentStatus: paid`
- PatientBalance não incrementa (se não for fiado)

---

### 2. PACKAGE (Pacote Therapy)

**Pré-requisito:** Criar pacote primeiro

**Fluxo:**
```
POST /v2/packages                    ← Cria pacote
  ↓
GET /v2/packages/:id                 ← Pega packageId
  ↓
POST /v2/appointments (com packageId) ← Agenda sessão
  ↓
PATCH /v2/appointments/:id/complete   ← Completa
  ↓
Package.sessionsDone++
```

**Teste:**
```bash
npm run test:e2e:package
```

**Validação Front:**
```javascript
// Após Create Package
const { packageId } = response.data;

// Após Create Session
expect(appointment.serviceType).toBe('package_session');
expect(appointment.hasPackage).toBe(true);

// Após Complete
const pkg = await getPackage(packageId);
expect(pkg.sessionsDone).toBe(1);
```

---

### 3. CONVÊNIO

**Pré-requisito:** Criar guia de autorização

**Fluxo:**
```
POST /v2/insurance-guides            ← Cria guia
  ↓
POST /v2/appointments (com insuranceGuideId)
  ↓
PATCH /v2/appointments/:id/complete
  ↓
InsuranceGuide.usedSessions++
```

**Teste:**
```bash
npm run test:e2e:convenio
```

**Validação Front:**
```javascript
// Após Create
expect(appointment.serviceType).toBe('convenio_session');
expect(appointment.billingType).toBe('convenio');
expect(appointment.paymentMethod).toBe('convenio');

// Após Complete
const guide = await getInsuranceGuide(guideId);
expect(guide.usedSessions).toBe(1);
expect(guide.status).toBe('active'); // ou 'exhausted' se esgotou
```

**Cenário de Erro:**
- Se `usedSessions >= totalSessions`: 
  - Erro: `INSURANCE_GUIDE_EXHAUSTED`
  - Não permite mais agendamentos

---

### 4. LIMINAR

**Pré-requisito:** Criar pacote tipo 'liminar'

**Fluxo:**
```
POST /v2/packages (type: 'liminar')
  ↓
POST /v2/appointments (com packageId do liminar)
  ↓
PATCH /v2/appointments/:id/complete
  ↓
Reconhece receita judicial
Package.liminarCreditBalance++
```

**Teste:**
```bash
npm run test:e2e:liminar
```

**Validação Front:**
```javascript
// Após Create Package
expect(package.type).toBe('liminar');
expect(package.liminarProcessNumber).toBeDefined();

// Após Complete
expect(appointment.paymentOrigin).toBe('liminar');
```

---

## 🎯 Comandos Rápidos

```bash
# Testar todos os fluxos E2E
npm run test:e2e:all

# Testar fluxo específico
npm run test:e2e:package   # Package + Particular
npm run test:e2e:convenio  # Convênio
npm run test:e2e:liminar   # Liminar
```

---

## ⚠️ Validações Importantes no Front

### Validação de Conflito
```javascript
if (error.code === 'SLOT_TAKEN') {
  // Horário já ocupado pelo doutor
  showError('Horário indisponível para este profissional');
}

if (error.code === 'PATIENT_DOUBLE_BOOKING') {
  // Paciente já tem agendamento nesse horário
  showError('Paciente já tem sessão agendada neste horário');
}
```

### Validação de Crédito (Package)
```javascript
if (error.code === 'PACKAGE_NO_CREDIT') {
  // Pacote esgotou as sessões
  showError('Pacote sem sessões disponíveis');
}
```

### Validação de Guia (Convênio)
```javascript
if (error.code === 'INSURANCE_GUIDE_EXHAUSTED') {
  // Guia esgotou
  showError('Guia de convênio esgotada');
}
```

---

## 📊 Status Finais Esperados

| Fluxo | operationalStatus | clinicalStatus | paymentStatus | Observação |
|-------|-------------------|----------------|---------------|------------|
| Particular (pago) | `completed` | `completed` | `paid` | Normal |
| Particular (fiado) | `completed` | `completed` | `pending_balance` | Add ao saldo |
| Package | `completed` | `completed` | `package_paid` | Crédito do pacote |
| Convênio | `completed` | `completed` | `pending_receipt` | Aguarda convênio |
| Liminar | `completed` | `completed` | `recognized` | Receita judicial |

---

## 🔥 Teste End-to-End Completo

```bash
# 1. Subir servidor
npm run dev

# 2. Em outro terminal, rodar todos os E2E
npm run test:e2e:all

# 3. Ver resultados
# ✅ 12 tests passed (4 fluxos × 3 testes cada)
```

**Pronto!** Todos os fluxos estão validados e prontos para uso no front! 🚀
