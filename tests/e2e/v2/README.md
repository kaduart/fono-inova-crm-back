# V2 CQRS E2E Tests

Testes E2E para arquitetura V2 (CQRS + Event-Driven).

## Como rodar

```bash
# Todos os testes E2E da V2
npm run test:e2e

# Apenas testes V2
npx vitest run tests/e2e/v2/ --config vitest.config.e2e.js

# Com verbose
npx vitest run tests/e2e/v2/ --config vitest.config.e2e.js --reporter=verbose
```

## Estrutura

- `full-flow.v2.e2e.test.js` - Fluxo completo happy path
  - Cria paciente → publica evento → processa projeção → verifica view
  - Fluxo completo: evento → projeção → leitura da view
  
- `chaos.v2.e2e.test.js` - Testes de resiliência
  - Idempotência: eventos duplicados criam uma view só
  - Idempotência: rebuild múltiplos mantém consistência
  - Race condition: múltiplos updates simultâneos
  
- `replay.v2.e2e.test.js` - Testes de replay/event sourcing
  - Rebuild: apaga view e reconstrói do evento
  - Determinismo: mesmo evento = mesmo resultado
  - Event sourcing: múltiplos eventos geram projeção correta

## Arquitetura dos Testes

Os testes usam `buildPatientView` diretamente (ao invés de aguardar workers):
- ✅ Testes são determinísticos (não dependem de timing)
- ✅ Rápidos (não precisam esperar workers processarem)
- ✅ Confiáveis (não falham por race conditions)

Isso testa o **fluxo completo**:
1. Criação do paciente no modelo
2. Publicação do evento (persiste no EventStore + envia para fila)
3. Processamento da projeção (buildPatientView)
4. Verificação da view materializada

## Requisitos

- MongoDB Atlas (crm_development)
- Redis local
- Variáveis de ambiente configuradas (MONGO_URI)

## Estado Atual

✅ Todos os testes V2 passando (8/8)
