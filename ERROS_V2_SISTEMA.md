# 🚨 Erros e Exceções do Sistema V2

Lista completa dos códigos de erro e mensagens para exibição no frontend.

## 📋 Índice de Erros

### 1. **CONFLICT_STATE** (HTTP 409)
Situações onde o estado atual do recurso conflita com a operação solicitada.

| Código | Mensagem | Quando Ocorre |
|--------|----------|---------------|
| `ALREADY_COMPLETED` | `Esta sessão já foi completada` | Tentativa de completar sessão já finalizada |
| `ALREADY_CANCELED` | `Este agendamento já foi cancelado` | Tentativa de cancelar já cancelado |
| `ALREADY_PROCESSING` | `Processamento já em andamento` | Duplo clique em operação |
| `CANNOT_CANCEL_COMPLETED` | `Não é possível cancelar uma sessão já completada` | Cancelar após completar |
| `CANNOT_COMPLETE_CANCELED` | `Não é possível completar um agendamento cancelado` | Completar após cancelar |

**Frontend:**
```typescript
if (isCriticalError(error)) {
  chat?.addSystemMessage?.(`❌ ${msg}`, 'error');
}
```

---

### 2. **NOT_FOUND** (HTTP 404)
Recursos não encontrados.

| Código | Mensagem |
|--------|----------|
| `APPOINTMENT_NOT_FOUND` | `Agendamento não encontrado` |
| `SESSION_NOT_FOUND` | `Sessão não encontrada` |
| `PATIENT_NOT_FOUND` | `Paciente não encontrado` |
| `PACKAGE_NOT_FOUND` | `Pacote não encontrado` |
| `PAYMENT_NOT_FOUND` | `Pagamento não encontrado` |
| `INSURANCE_GUIDE_NOT_FOUND` | `Guia de convênio não encontrada` |

---

### 3. **VALIDATION_ERROR** (HTTP 400)
Erros de validação de dados. **Não vão pro chat** (só toast).

| Código | Mensagem |
|--------|----------|
| `PATIENT_REQUIRED` | `Paciente é obrigatório` |
| `DOCTOR_REQUIRED` | `Profissional é obrigatório` |
| `DATE_REQUIRED` | `Data é obrigatória` |
| `TIME_REQUIRED` | `Horário é obrigatório` |
| `INVALID_DATE` | `Data inválida` |
| `INVALID_OBJECT_ID` | `ID inválido` |

---

### 4. **BUSINESS_RULE_VIOLATION** (HTTP 422)
Violações de regras de negócio. **Vão pro chat** (críticos).

| Código | Mensagem | Impacto |
|--------|----------|---------|
| `PACKAGE_NO_CREDIT` | `Pacote sem créditos disponíveis` | Alto |
| `PACKAGE_EXHAUSTED` | `Créditos do pacote esgotados` | Alto |
| `INSURANCE_GUIDE_EXHAUSTED` | `Guia de convênio esgotada` | Alto |
| `TIME_CONFLICT` | `Já existe um agendamento neste horário` | Médio |
| `DOCTOR_UNAVAILABLE` | `Profissional não disponível` | Médio |

---

### 5. **INSUFFICIENT_CREDIT** (HTTP 422)
Créditos insuficientes. **Vão pro chat**.

| Código | Mensagem |
|--------|----------|
| `INSUFFICIENT_BALANCE` | `Saldo insuficiente` |
| `CREDIT_EXHAUSTED` | `Créditos esgotados` |

---

### 6. **INTERNAL_ERROR** (HTTP 500)
Erros internos. **Vão pro chat**.

| Código | Mensagem |
|--------|----------|
| `INTERNAL_ERROR` | `Erro interno do servidor` |
| `DATABASE_ERROR` | `Erro ao acessar o banco de dados` |
| `WORKER_ERROR` | `Erro no processamento assíncrono` |
| `TIMEOUT_ERROR` | `Tempo de processamento excedido` |

---

## 🎯 Filtros no Frontend

### Erros que VÃO pro chat (críticos):

```typescript
const CRITICAL_ERROR_CODES = [
  'CONFLICT_STATE',
  'ALREADY_EXISTS',
  'INSUFFICIENT_CREDIT',
  'BUSINESS_RULE_VIOLATION',
  'INTERNAL_ERROR',
  'WORKER_ERROR'
];
```

### Erros que NÃO vão pro chat (normais):

- `VALIDATION_ERROR`
- `INVALID_OBJECT_ID`
- `NOT_FOUND` (menos crítico)
- `MISSING_REQUIRED_FIELD`

---

## 🔧 Uso no Frontend

### Padrão Completo

```typescript
import { 
  extractErrorMessage, 
  extractErrorCode,
  isCriticalError,
  isNetworkError 
} from '../utils/errorUtils';
import { useChatOptional } from '../contexts/ChatContext';

try {
  await operation();
} catch (error) {
  const msg = extractErrorMessage(error, 'Erro na operação');
  const code = extractErrorCode(error);
  
  // Toast sempre (com ID para evitar spam)
  toast.error(msg, { id: msg });
  
  // Chat só se crítico
  if (isCriticalError(error)) {
    chat?.addSystemMessage?.(`❌ ${msg}`, 'error');
  }
  
  // Métricas/Logs
  console.error(`[${code}] ${msg}`);
}
```

---

## 📁 Arquivos de Referência

- **Mensagens**: `back/utils/apiMessages.js`
- **Códigos**: `back/utils/apiMessages.js` → `ErrorCodes`
- **Middleware**: `back/middleware/errorHandler.js`
- **Utilitário Frontend**: `front/src/utils/errorUtils.ts`
- **Wrapper Safe**: `front/src/utils/safeAction.ts`
- **Documentação**: `front/docs/PADRAO_ERROS_V2.md`

---

## 🔄 Resposta Padrão do Backend

```json
{
  "success": false,
  "error": {
    "code": "CONFLICT_STATE",
    "message": "Esta sessão já foi completada",
    "details": null,
    "timestamp": "2025-01-01T00:00:00.000Z"
  }
}
```

Ou formato simplificado:

```json
{
  "success": false,
  "error": "Esta sessão já foi completada",
  "code": "CONFLICT_STATE"
}
```

---

## 🎨 UX Recomendada

### Toast
- ✅ Sempre mostrar
- ✅ Usar `{ id: msg }` para evitar spam
- ✅ Mensagem curta e clara

### Chat
- ✅ Só erros críticos
- ✅ Ícone adequado (⚠️ erro, ⚡ warning, ℹ️ info)
- ✅ Auto-remove após 30s
- ✅ Agrupar mensagens iguais

### Console
- ✅ Log completo para debug
- ✅ Código do erro
- ✅ Stack trace em dev
