# Projection Contract System

Sistema de contratos para garantir consistência de IDs entre Aggregate Roots e suas projeções (views) CQRS.

## Por que existe?

**Problema:** O sistema teve bugs recorrentes onde o frontend recebia `_id` da view ao invés do `patientId`, causando:
- Agendamentos criados com referência errada
- Buscas que não encontravam pacientes
- Dados desatualizados sem explicação

**Causa raiz:** Projeções 1:1 (como PatientView) estavam gerando `_id` próprio em vez de usar o ID do source.

**Solução:** Contratos explícitos que definem a estratégia de ID para cada tipo de projeção.

## Tipos de Projeção

```javascript
ProjectionType.ONE_TO_ONE_VIEW   // Projeção 1:1 (PatientView)
ProjectionType.ONE_TO_MANY_VIEW  // Agregação (DashboardStats)
ProjectionType.EVENT_VIEW        // Event sourcing (AuditLog)
ProjectionType.SNAPSHOT_VIEW     // Snapshot versionado
```

## Estratégias de ID

```javascript
IdentityStrategy.SHARED     // _id da view = _id do source (1:1)
IdentityStrategy.GENERATED  // _id próprio gerado pelo Mongo
```

## Uso

### 1. Criar um novo contrato

```javascript
import { ProjectionContract, ProjectionType, IdentityStrategy } from '../contracts/ProjectionContract.js';

export const AppointmentViewContract = new ProjectionContract({
  type: ProjectionType.ONE_TO_ONE_VIEW,
  sourceAggregate: 'Appointment',
  identityStrategy: IdentityStrategy.SHARED,
  collectionName: 'appointments_view',
  mongooseModel: 'AppointmentView'
});
```

### 2. Usar no serviço de projeção

```javascript
import { ProjectionService } from '../services/projections/ProjectionService.js';
import { AppointmentViewContract } from '../contracts/ProjectionContract.js';
import AppointmentView from '../models/AppointmentView.js';

const projectionService = new ProjectionService(AppointmentViewContract, AppointmentView);

// Cria/atualiza projeção com ID correto
await projectionService.upsert(appointment, (apt) => ({
  patientId: apt.patient,
  doctorId: apt.doctor,
  date: apt.date,
  status: apt.status
  // _id será setado automaticamente = apt._id (SHARED strategy)
}));
```

### 3. Buscar projeção

```javascript
// Funciona para SHARED ou GENERATED
const view = await projectionService.findBySourceId(appointment._id);
```

## Contratos Existentes

| Contrato | Tipo | Strategy | Descrição |
|----------|------|----------|-----------|
| `PatientViewContract` | ONE_TO_ONE_VIEW | SHARED | View de paciente (mesmo ID) |
| `PatientHistoryContract` | EVENT_VIEW | GENERATED | Histórico de mudanças (ID próprio) |

## Regras

1. **ONE_TO_ONE_VIEW** → sempre use `SHARED`
2. **EVENT_VIEW** → sempre use `GENERATED`
3. **ONE_TO_MANY_VIEW** → geralmente `GENERATED`
4. **SNAPSHOT_VIEW** → geralmente `GENERATED`

## Validação

O sistema valida automaticamente:

```javascript
// Lança erro se _id !== sourceId em projeção SHARED
PatientViewContract.validateConsistency(patientId);
```
