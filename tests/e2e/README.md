# 🧪 Testes E2E - CRM 4.0

## Rodar Testes E2E

### 1. Teste de Fluxo de Pacote (Package)

```bash
npm run test:e2e:package
```

Este teste executa o fluxo completo:
1. ✅ Cria pacote therapy
2. ✅ Cria agendamento de pacote  
3. ✅ Completa agendamento
4. ✅ Valida `package.sessionsDone` incrementado

### 2. Todos os Testes E2E

```bash
npm run test:e2e
```

### 3. Testes E2E V2 Específicos

```bash
# Teste de fluxo completo
npx vitest run tests/e2e/v2/full-flow.v2.e2e.test.js

# Teste de caos/estresse
npx vitest run tests/e2e/v2/chaos.v2.e2e.test.js

# Teste de replay de eventos
npx vitest run tests/e2e/v2/replay.v2.e2e.test.js
```

## Estrutura dos Testes

```
tests/e2e/
├── v2/
│   ├── package-flow.v2.e2e.test.js      ← 🆕 NOVO: Fluxo de pacote
│   ├── full-flow.v2.e2e.test.js         ← Fluxo de paciente
│   ├── chaos.v2.e2e.test.js             ← Testes de caos
│   ├── replay.v2.e2e.test.js            ← Replay de eventos
│   └── worker-integration.v2.e2e.test.js ← Integração workers
└── README.md
```

## Requisitos

- MongoDB Atlas conectado
- Variável `MONGO_URI` configurada
- Workers não precisam estar rodando (testes simulam workers)

## Dados de Teste

Os testes criam dados reais no banco:
- Paciente: `E2E Package Test Patient`
- Doutor: Busca existente ou cria `Dr. E2E Test`
- Pacote: 5 sessões, valor 200

**Cleanup automático**: Dados são apagados após cada teste.

## Falhas Comuns

| Erro | Causa | Solução |
|------|-------|---------|
| `APPOINTMENT_NOT_FOUND` | Worker não processou | Aumentar delay no teste |
| `PACKAGE_NO_CREDIT` | Pacote sem sessões | Verificar `totalSessions` |
| Timeout | MongoDB lento | Aumentar timeout do teste |
