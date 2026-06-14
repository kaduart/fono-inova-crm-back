# Queries Oficiais — Uso da Aba "Projeção & Cenários"

> **Data:** 2026-06-13  
> **Objetivo:** padronizar como o time consulta métricas de uso da aba **Projeção & Cenários**, do endpoint legado `projection-daily` e do modelo `FinancialProjection`.  
> **Fonte:** `MetricLog` (TTL 30 dias).  
> **Relatório automatizado:** `node back/scripts/report-projection-usage.js`

---

## 1. Quem realmente abriu a aba

```javascript
db.metriclogs.aggregate([
  {
    $match: {
      service: "ProjectionTab",
      operation: "opened",
      timestamp: {
        $gte: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000)
      }
    }
  },
  {
    $group: {
      _id: {
        userId: "$data.userId",
        role: "$data.role"
      },
      opens: { $sum: 1 },
      lastAccess: { $max: "$timestamp" }
    }
  },
  {
    $sort: { opens: -1 }
  }
])
```

**Resultado esperado:**

```text
Maria (secretary)     42 acessos
João (admin)          3 acessos
```

Essa é a consulta mais importante para a decisão.

---

## 2. Quantas vezes o gráfico legado foi carregado

```javascript
db.metriclogs.aggregate([
  {
    $match: {
      service: "LegacyFinancialDashboard",
      operation: "projection-daily-request",
      timestamp: {
        $gte: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000)
      }
    }
  },
  {
    $group: {
      _id: null,
      totalRequests: { $sum: 1 },
      uniqueUsers: {
        $addToSet: "$data.userId"
      }
    }
  },
  {
    $project: {
      _id: 0,
      totalRequests: 1,
      uniqueUsers: {
        $size: "$uniqueUsers"
      }
    }
  }
])
```

**Responde:**

- A aba existe, mas ninguém carrega o gráfico?
- Ou o gráfico é usado diariamente?

---

## 3. `FinancialProjection` ainda tem consumidor?

```javascript
db.metriclogs.aggregate([
  {
    $match: {
      service: {
        $in: [
          "FinancialProjection",
          "ReconciliationWorker"
        ]
      },
      timestamp: {
        $gte: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000)
      }
    }
  },
  {
    $group: {
      _id: {
        service: "$service",
        operation: "$operation"
      },
      count: { $sum: 1 },
      lastSeen: { $max: "$timestamp" }
    }
  },
  {
    $sort: {
      count: -1
    }
  }
])
```

**Mostra:**

- Se o modelo está apenas sendo atualizado por workers.
- Se realmente participa de alguma funcionalidade relevante.

---

## 4. Go / No-Go para remoção na Sprint 3.11

```javascript
db.metriclogs.countDocuments({
  service: "ProjectionTab",
  operation: "opened",
  timestamp: {
    $gte: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000)
  }
})
```

**Regra de decisão:**

| Retorno | Ação |
|---|---|
| `0` | **Remover** — nenhum acesso na janela |
| `1` a `3` | **Avaliar remoção** — uso muito baixo, confirmar com entrevistas |
| `4+` | **Manter / Incorporar / Evoluir** — uso detectado |

---

## 5. Relatório final de decisão (template)

```text
PROJECTION TAB USAGE REPORT

Período:
01/06/2026 → 15/06/2026

ProjectionTab.opened:
- Total acessos: X
- Usuários únicos: Y

Top usuários:
1. Maria (secretária) - 42
2. Ana (financeiro) - 7

projection-daily-request:
- Total chamadas: X
- Usuários únicos: Y

FinancialProjection:
- Leituras: X
- Escritas: Y

DECISÃO:

[ ] Remover
[ ] Incorporar em Metas
[ ] Evoluir na Sprint 4

Justificativa:
...
```

---

## 6. Script automatizado

Para gerar o relatório completo em texto ou JSON:

```bash
# Padrão: últimos 15 dias, saída em texto
node back/scripts/report-projection-usage.js

# Janela customizada
node back/scripts/report-projection-usage.js --start=2026-06-01 --end=2026-06-15

# Últimos 7 dias em JSON
node back/scripts/report-projection-usage.js --days=7 --json
```

O script salva automaticamente um arquivo `projection-usage-report-YYYY-MM-DD_YYYY-MM-DD.txt` no diretório raiz.

---

## Referências

- [`SPRINT_3_10_1_AUDITORIA_PROJECAO_CENARIOS.md`](../../SPRINT_3_10_1_AUDITORIA_PROJECAO_CENARIOS.md)
- [`SPRINT_3_10_2_MEDICAO_USO_PROJECAO.md`](../../SPRINT_3_10_2_MEDICAO_USO_PROJECAO.md)
- `back/scripts/report-projection-usage.js`
