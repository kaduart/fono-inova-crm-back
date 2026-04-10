#!/usr/bin/env node
/**
 * Diagnóstico de Memória - Identifica vazamentos
 */

import v8 from 'v8';
import process from 'process';

console.log('🔍 DIAGNÓSTICO DE MEMÓRIA\n');

// Heap inicial
const heapStats = v8.getHeapStatistics();
console.log('📊 Heap Statistics:');
console.log(`  Total: ${(heapStats.total_heap_size / 1024 / 1024).toFixed(2)} MB`);
console.log(`  Usado: ${(heapStats.used_heap_size / 1024 / 1024).toFixed(2)} MB`);
console.log(`  Limite: ${(heapStats.heap_size_limit / 1024 / 1024).toFixed(2)} MB`);
console.log(`  % Usado: ${((heapStats.used_heap_size / heapStats.heap_size_limit) * 100).toFixed(1)}%\n`);

// RSS
const usage = process.memoryUsage();
console.log('📊 Memory Usage:');
console.log(`  RSS: ${(usage.rss / 1024 / 1024).toFixed(2)} MB`);
console.log(`  Heap: ${(usage.heapUsed / 1024 / 1024).toFixed(2)} MB`);
console.log(`  External: ${(usage.external / 1024 / 1024).toFixed(2)} MB`);
console.log(`  Array Buffers: ${(usage.arrayBuffers / 1024 / 1024).toFixed(2)} MB\n`);

// Verificar workers
console.log('📊 Verificando variáveis de ambiente:');
console.log(`  NODE_OPTIONS: ${process.env.NODE_OPTIONS || '(não definido)'}`);
console.log(`  WATCHDOG_MODE: ${process.env.WATCHDOG_MODE || 'interval'}`);
console.log(`  NODE_ENV: ${process.env.NODE_ENV || 'development'}\n`);

// Dicas
console.log('💡 DICAS PARA REDUZIR MEMÓRIA:');
console.log('  1. Limitar número de workers simultâneos');
console.log('  2. Usar WATCHDOG_MODE=none em desenvolvimento');
console.log('  3. Aumentar --max-old-space-size');
console.log('  4. Verificar conexões Redis não fechadas');
console.log('  5. Usar lazy loading para imports pesados\n');

// Snapshot se necessário
if (usage.heapUsed > 200 * 1024 * 1024) {
    console.log('⚠️  Heap > 200MB - considere reiniciar o servidor');
}
