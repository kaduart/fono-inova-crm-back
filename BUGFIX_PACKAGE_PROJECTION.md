# 🐛 BUGFIX: Fila package-projection não existia

## Problema
O evento `SESSION_COMPLETED` era mapeado para a fila `'package-projection'`, mas a fila não estava criada no `eventPublisher.js`.

Isso causava:
- Evento publicado no Event Store ✅
- Evento NÃO enfileirado para processamento ❌
- PackagesView NUNCA atualizava automaticamente ❌

## Solução
Adicionar as filas faltantes no `eventPublisher.js`:

```javascript
'package-projection': new Queue('package-projection', { connection: redisConnection }),
'billing-orchestrator': new Queue('billing-orchestrator', { connection: redisConnection })
```

## Impacto
- CQRS agora funciona automaticamente ✅
- Workers recebem eventos corretamente ✅
- Views se atualizam em tempo real ✅

## Teste
1. Reiniciar servidor
2. Completar sessão de convênio
3. Verificar PackagesView atualizada automaticamente
