/**
 * 🧪 Testes unitários para resolveSessionFinancialValue
 *
 * Uso:
 *   cd back && node utils/resolveSessionFinancialValue.test.js
 */

import { resolveSessionFinancialValue } from './resolveSessionFinancialValue.js';

function assertEqual(actual, expected, label) {
  const pass = actual === expected;
  console.log(`${pass ? '✅' : '❌'} ${label}: expected=${expected}, actual=${actual}`);
  if (!pass) process.exitCode = 1;
}

console.log('Running resolveSessionFinancialValue tests...\n');

// 1. package.sessionValue existe → usar ele
assertEqual(
  resolveSessionFinancialValue({ sessionValue: 50, package: { sessionValue: 160, totalValue: 800, totalSessions: 5 } }),
  160,
  'package.sessionValue explícito tem prioridade'
);

// 2. só totalValue/totalSessions → dividir
assertEqual(
  resolveSessionFinancialValue({ sessionValue: 50, package: { totalValue: 800, totalSessions: 5 } }),
  160,
  'prorata totalValue / totalSessions quando sessionValue do pacote não existe'
);

// 3. session.sessionValue quando não há pacote
assertEqual(
  resolveSessionFinancialValue({ sessionValue: 140 }),
  140,
  'session.sessionValue quando não há pacote'
);

// 4. sem nada → 0
assertEqual(
  resolveSessionFinancialValue({}),
  0,
  'objeto vazio retorna 0'
);

assertEqual(
  resolveSessionFinancialValue(null),
  0,
  'null retorna 0'
);

// 5. divisão decimal → arredondamento consistente
assertEqual(
  resolveSessionFinancialValue({ package: { totalValue: 1000, totalSessions: 3 } }),
  333,
  'arredondamento: 1000/3 = 333'
);

assertEqual(
  resolveSessionFinancialValue({ package: { totalValue: 100, totalSessions: 3 } }),
  33,
  'arredondamento: 100/3 = 33'
);

// 6. package com sessionValue = 0 mas totalValue válido
assertEqual(
  resolveSessionFinancialValue({ package: { sessionValue: 0, totalValue: 500, totalSessions: 4 } }),
  125,
  'sessionValue=0 no pacote cai para prorata'
);

// 7. _pkg populado (formato aggregation)
assertEqual(
  resolveSessionFinancialValue({ sessionValue: 50, _pkg: [{ sessionValue: 180 }] }),
  180,
  '_pkg array populado tem prioridade'
);

// 8. campo legado 'value'
assertEqual(
  resolveSessionFinancialValue({ value: 120 }),
  120,
  'campo legado value funciona como fallback'
);

// 9. valor negativo não deve ocorrer, mas garantir segurança
assertEqual(
  resolveSessionFinancialValue({ sessionValue: -50 }),
  0,
  'valor negativo é ignorado (retorna 0 pois não passa nos >0)'
);

console.log('\n' + (process.exitCode === 1 ? 'Some tests FAILED' : 'All tests PASSED ✅'));
