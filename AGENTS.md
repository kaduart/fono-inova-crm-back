# AGENTS.md - CRM Fono Inova Backend

> Arquivo de referência para agentes de código AI. Este documento descreve a arquitetura, convenções e práticas do projeto.

---

## 1. Visão Geral do Projeto

O **CRM Fono Inova** é um sistema de gestão clínica completo para clínicas de fonoaudiologia. É uma aplicação Node.js com arquitetura **Event-Driven** (4.0) migrando de código legado, utilizando MongoDB como banco principal e Redis para filas.

### Stack Tecnológico

| Camada | Tecnologia |
|--------|------------|
| Runtime | Node.js 18+ (ES Modules) |
| Framework | Express.js 4.x |
| Banco de Dados | MongoDB (Mongoose 8.x) |
| Filas | BullMQ 5.x + Redis |
| Testes | Vitest + Jest |
| Processamento | Workers assíncronos |
| WebSocket | Socket.io 4.x |

### Principais Funcionalidades

- **Gestão de Pacientes**: Cadastro, prontuários, evoluções
- **Agendamentos**: Sessões clínicas com múltiplos status
- **Pacotes de Terapia**: Controle de sessões pagas/executadas
- **Financeiro**: Pagamentos, convênios, faturamento
- **WhatsApp Bot**: Atendimento automatizado (Amanda AI)
- **Marketing**: Integração Meta Ads, Google Ads, GMB
- **Convênios**: Gestão de guias TISS, lotes

---

## 2. Estrutura de Diretórios

```
back/
├── server.js                 # Entry point principal
├── package.json              # Dependências e scripts
├── ecosystem.config.cjs      # Configuração PM2
│
├── config/                   # Configurações globais
│   ├── bullConfig.js        # Filas BullMQ
│   ├── redisConnection.js   # Conexão Redis
│   ├── socket.js            # WebSocket config
│   └── cronManager.js       # Gerenciador de crons
│
├── routes/                   # Rotas HTTP (103 arquivos)
│   ├── appointment.v2.js    # Agendamentos V2 (Event-Driven)
│   ├── patient.v2.js        # Pacientes V2
│   ├── payment.v2.js        # Pagamentos V2
│   └── ...
│
├── controllers/              # Controladores (26 arquivos)
├── models/                   # Modelos Mongoose (68 arquivos)
│   ├── Appointment.js
│   ├── Patient.js
│   ├── Payment.js
│   ├── Package.js
│   └── ...
│
├── middleware/               # Middlewares (25 arquivos)
│   ├── auth.js              # Autenticação JWT
│   ├── errorHandler.js      # Tratamento de erros
│   ├── rateLimiter.js       # Rate limiting
│   └── sanitize.js          # Sanitização de dados
│
├── domain/                   # 🧠 Regras de negócio puras (DDD)
│   ├── session/             # Sessões clínicas
│   │   ├── cancelSession.js
│   │   └── completeSession.js
│   ├── payment/             # Pagamentos
│   ├── package/             # Pacotes
│   ├── insurance/           # Convênios
│   └── index.js             # Exportações
│
├── domains/                  # 🏗️ Domínios organizados
│   ├── billing/             # Faturamento
│   ├── clinical/            # Clínico
│   ├── integration/         # Integrações
│   └── whatsapp/            # WhatsApp
│
├── workers/                  # 🎼 Processadores de fila
│   ├── index.js             # Inicializador
│   ├── cancelOrchestratorWorker.js
│   ├── completeOrchestratorWorker.js
│   └── ...
│
├── infrastructure/           # 🏗️ Infraestrutura
│   ├── events/              # Eventos
│   │   ├── eventPublisher.js
│   │   └── eventStoreService.js
│   ├── queue/               # Config de filas
│   └── observability/       # Monitoramento
│
├── projections/              # 📊 Projeções read-only
│   └── financialProjection.js
│
├── services/                 # Serviços de negócio
├── utils/                    # Utilitários (38 arquivos)
├── constants/                # Constantes
├── tests/                    # Testes (119 arquivos)
│   ├── unit/
│   ├── e2e/
│   ├── integration/
│   └── billing/
│
├── handlers/                 # Handlers de eventos
├── orchestrators/            # Orquestradores
├── adapters/                 # Adaptadores
├── detectors/                # Detectores
├── crons/                    # Tarefas agendadas
├── jobs/                     # Jobs
├── seeds/                    # Seeds de dados
└── scripts/                  # Scripts utilitários
```

---

## 3. Arquitetura Event-Driven 4.0

O sistema está em migração de código legado para arquitetura **Event-Driven** com padrões modernos:

### Conceitos Principais

1. **Event Store**: Persistência append-only de eventos (`models/EventStore.js`)
2. **Outbox Pattern**: Eventos salvos no mesmo commit do banco
3. **Saga Pattern**: Compensação em caso de falha
4. **Idempotência**: Eventos nunca processados 2x
5. **Feature Flags**: Rollout gradual (0% → 100%)

### Fluxo de Eventos

```
API Route → Publica Evento → Fila BullMQ → Worker → Resultado
                ↓
          Event Store (persiste)
```

### Tipos de Eventos (EventTypes)

```javascript
// Intenções (REQUESTED) - Entrada da API
APPOINTMENT_CREATE_REQUESTED
APPOINTMENT_CANCEL_REQUESTED
APPOINTMENT_COMPLETE_REQUESTED

// Resultados (COMPLETED/FAILED) - Saída dos workers
APPOINTMENT_CREATED
APPOINTMENT_CANCELED
APPOINTMENT_COMPLETED

// Domínio específico
SESSION_COMPLETED
PAYMENT_RECEIVED
PACKAGE_CREDIT_CONSUMED
INSURANCE_GUIDE_CONSUMED
```

### Publicando Eventos

```javascript
import { publishEvent, EventTypes } from '../infrastructure/events/eventPublisher.js';

await publishEvent(
    EventTypes.APPOINTMENT_CREATED,
    { patientId, doctorId, date, time },
    { 
        correlationId: 'uuid-da-requisicao',
        idempotencyKey: 'appointment_123_create'
    }
);
```

### Feature Flags

Arquivo `.env`:
```bash
FF_CREATE_V2=true        # Criar agendamento via 4.0
FF_COMPLETE_V2=true      # Finalizar sessão via 4.0
FF_CANCEL_V2=true        # Cancelar via 4.0
FF_EMERGENCY_ROLLBACK=false  # Rollback emergencial
```

---

## 4. Comandos de Build e Teste

### Scripts Principais (package.json)

```bash
# Desenvolvimento
npm run dev              # Servidor com nodemon
npm run dev:check        # Servidor + workers

# Produção
npm start                # Servidor otimizado
npm run worker           # Worker de followup
npm run worker:doctor    # Worker de médicos

# Testes
npm run test:vitest              # Testes unitários + e2e
npm run test:amanda              # Testes Amanda AI
npm run test:e2e                 # Apenas E2E
npm run test:e2e:bugfixes        # Testes de bugfixes
npm run test:coverage            # Com cobertura
npm run test:safety              # Testes críticos de segurança
npm run test:all                 # Todos os testes

# Billing V2
npm run billing:validate         # Validar billing
npm run billing:monitor          # Monitorar
npm run billing:rollback         # Rollback emergência
npm run billing:go-live          # Ativar V2
npm run billing:worker           # Worker de billing
npm run test:billing:e2e         # Testes E2E billing
npm run test:billing:integration # Testes integração
npm run test:billing:load        # Testes de carga
```

### PM2 (Produção)

```bash
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Configuração inclui:
- `crm-api`: Servidor HTTP (300MB max memory)
- `crm-worker`: Workers de fila (400MB max memory)
- `crm-watchdog`: Monitoramento (150MB max memory)

---

## 5. Convenções de Código

### Estilo

- **ES Modules**: `import/export` (não usar `require`)
- **Async/Await**: Preferido sobre callbacks
- **Camel Case**: `nomeDaVariavel`, `nomeDaFuncao`
- **Pascal Case**: Classes e modelos (`Appointment`, `PatientService`)
- **Constantes**: UPPER_SNAKE_CASE para valores fixos

### Estrutura de Arquivos

```javascript
// 1. Imports externos
import express from 'express';
import mongoose from 'mongoose';

// 2. Imports internos
import { auth } from '../middleware/auth.js';
import Appointment from '../models/Appointment.js';

// 3. Código principal
export const router = express.Router();

// 4. Exports
export default router;
```

### Logging

```javascript
import { createContextLogger } from '../utils/logger.js';

const log = createContextLogger(correlationId, 'nome_componente');

log.info('acao_iniciada', 'Descrição', { dado1, dado2 });
log.error('acao_falhou', 'Erro', { error: err.message });
```

### Tratamento de Erros

```javascript
// Middleware de erro (centralizado)
app.use(errorHandler);

// Em controllers
export async function handler(req, res, next) {
    try {
        // ... código
    } catch (error) {
        next(error); // Delega para errorHandler
    }
}
```

---

## 6. Testes

### Estrutura de Testes

```
tests/
├── unit/                  # Testes unitários isolados
├── e2e/                   # Testes end-to-end
├── integration/           # Testes de integração
├── billing/               # Testes específicos de billing
├── amanda/                # Testes da IA Amanda
└── stress/                # Testes de carga
```

### Configuração Vitest

Arquivo `vitest.config.js`:
- Environment: `node`
- Timeout: 30s (para MongoDB)
- Coverage: v8 provider

### Exemplo de Teste

```javascript
import { describe, it, expect } from 'vitest';
import { completeSession } from '../domain/session/completeSession.js';

describe('Complete Session', () => {
    it('should mark session as completed', async () => {
        const session = await createTestSession();
        const result = await completeSession(session, { userId: '123' });
        expect(result.status).toBe('completed');
    });
});
```

### Bancos de Teste

- `crm_development`: Desenvolvimento local
- `crm_test_e2e`: Testes E2E (pode ser limpo)
- `test`: ⚠️ PRODUÇÃO REAL - nunca usar em desenvolvimento

---

## 7. Modelos Principais

### Appointment (Agendamento)

```javascript
{
    patient: ObjectId,
    doctor: ObjectId,
    date: Date,
    time: String,
    status: String,          // scheduled, completed, canceled
    clinicalStatus: String,  // confirmed, completed, canceled
    paymentStatus: String,   // pending, paid, canceled
    package: ObjectId,       // Referência ao pacote
    kind: String,            // particular, convenio, liminar
    // ... mais campos
}
```

### Package (Pacote de Terapia)

```javascript
{
    patient: ObjectId,
    specialty: ObjectId,
    totalSessions: Number,
    sessionsDone: Number,
    totalValue: Number,
    totalPaid: Number,
    balance: Number,
    status: String           // active, exhausted, canceled
}
```

### Payment (Pagamento)

```javascript
{
    appointment: ObjectId,
    package: ObjectId,
    amount: Number,
    billingType: String,     // particular, convenio, pix, credit_card
    status: String,          // pending, paid, canceled
    kind: String             // session_payment, package_receipt
}
```

### Patient (Paciente)

```javascript
{
    name: String,
    phone: String,
    email: String,
    birthday: Date,
    convenio: ObjectId,
    liminarCreditBalance: Number
}
```

---

## 8. Workers e Filas

### Filas Principais (BullMQ)

| Fila | Propósito |
|------|-----------|
| `appointment-processing` | Criar/editar agendamentos |
| `cancel-orchestrator` | Cancelamento com compensação |
| `complete-orchestrator` | Finalização de sessão |
| `payment-processing` | Processar pagamentos |
| `balance-update` | Atualizar saldos |
| `package-processing` | Processar pacotes |
| `patient-projection` | Projeções de paciente |
| `notification` | Enviar notificações |
| `whatsapp-inbound` | Mensagens recebidas |

### Criando um Worker

```javascript
import { Worker } from 'bullmq';
import { redisConnection } from '../config/redisConnection.js';

export const myWorker = new Worker(
    'queue-name',
    async (job) => {
        const { eventId, payload, correlationId } = job.data;
        // Processamento...
        return { status: 'completed' };
    },
    { 
        connection: redisConnection,
        concurrency: 5
    }
);
```

---

## 9. Considerações de Segurança

### Autenticação

- JWT para APIs
- Tokens específicos para WhatsApp webhooks
- `ADMIN_API_TOKEN` para rotas administrativas

### Middlewares de Segurança

```javascript
// Implementados no server.js
app.use(helmet());           // Headers de segurança
app.use(expressMongoSanitize()); // Sanitização MongoDB
app.use(...sanitizeStack()); // XSS protection
app.use(rateLimiter);        // Rate limiting
```

### Variáveis Sensíveis

- Nunca commitar `.env`
- Usar `.env.example` como template
- Rotas críticas devem usar `auth` middleware

### Validação de Entrada

```javascript
import { validateId } from '../middleware/validateId.js';
import { validateSession } from '../middleware/validateSession.js';

router.post('/', validateId, validateSession, handler);
```

---

## 10. Deploy e Ambientes

### Arquivos de Ambiente

| Arquivo | Uso |
|---------|-----|
| `.env` | Atual (copiado de um dos abaixo) |
| `.env.development` | Desenvolvimento local |
| `.env.production` | Produção |
| `.env.local` | Configurações locais específicas |
| `.env.backup` | Backup automático |

### Alternando Ambientes

```bash
# Para desenvolvimento
./scripts/switch-env.sh development

# Para produção (cuidado!)
./scripts/switch-env.sh production
```

### Verificando Ambiente

```bash
grep "MONGO_URI" .env
# Se conter "production", é PRODUÇÃO REAL
# Se conter "development", é ambiente de testes
```

### Health Checks

```bash
GET /health           # Básico
GET /health/full      # Completo (DB, Redis, etc)
GET /api/health       # Health Check V2
GET /api/health/migration  # Status migração V1→V2
```

---

## 11. Regras de Negócio Importantes

### Agendamentos

- **Create**: Cria sessão + valida pacote + publica evento
- **Complete**: Marca completa + consome pacote + cria pagamento
- **Cancel**: Preserva dados em `original*` + cancela pagamentos (exceto pacote)

### Pacotes

- **Consumo**: `sessionsDone++` apenas se tiver crédito
- **Reaproveitamento**: Busca sessões canceladas com `originalPartialAmount > 0`
- **Regras Financeiras**: Atualiza `totalPaid`, `paidSessions`, `balance`

### Convênios

- **Guias**: Controle de `usedSessions` por guia
- **Lotes**: Fluxo de criação → processamento → selagem → envio
- **Glosa**: Evento específico para `INSURANCE_GLOSA`

### Pagamentos

- **Nunca cancelar** se `kind === 'package_receipt'` ou `'session_payment'`
- **Confirmação pós-commit**: Pagamentos criados fora da transação
- **Múltiplos métodos**: particular, convênio, liminar, pix, cartão

---

## 12. Troubleshooting

### Problemas Comuns

**Redis desconectado:**
```
⚠️ Redis indisponível - sistema continua em modo degradado
```
- Workers não iniciam, mas API continua funcionando

**MongoDB timeout:**
```
Server selection timeout
```
- Verificar `MONGO_URI` no `.env`

**Evento duplicado:**
```
🚨 [DUPLICATE_PARTICULAR] Evento particular travado em 'processing'
```
- Verificar Event Store e limpar se necessário

### Logs Importantes

- `server.js`: Logs de inicialização
- `logs/combined.log`: Logs PM2
- `logs/error.log`: Erros PM2

### Comandos Úteis

```bash
# Verificar filas Redis
redis-cli keys "bull:*"

# Limpar fila específica
redis-cli del "bull:appointment-processing:wait"

# Ver event store
mongo --eval "db.eventstores.find().sort({createdAt:-1}).limit(10)"

# Restart workers
pm2 restart crm-worker
```

---

## 13. Documentação Adicional

- `ARQUITETURA_4.0_COMPLETA.md`: Arquitetura detalhada
- `FLUXO_EVENT_DRIVEN.md`: Sistema event-driven
- `AMBIENTES.md`: Gestão de ambientes
- `REGRAS_NEGOCIO_CONSOLIDADO.md`: Regras de negócio
- `CHECKLIST-PRODUCAO-SEGURA.md`: Checklist de deploy

---

**Última atualização:** 2026-04-11
