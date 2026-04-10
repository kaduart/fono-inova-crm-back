#!/usr/bin/env node
/**
 * Debug de Memory Leak - Identifica fonte do vazamento
 */

import v8 from 'v8';
import fs from 'fs';

const snapshots = [];

function captureSnapshot(label) {
    const mem = process.memoryUsage();
    const heap = v8.getHeapStatistics();
    
    snapshots.push({
        label,
        time: Date.now(),
        heapUsed: mem.heapUsed,
        heapTotal: mem.heapTotal,
        rss: mem.rss,
        external: mem.external,
        heapLimit: heap.heap_size_limit
    });
    
    console.log(`[${label}] Heap: ${(mem.heapUsed/1024/1024).toFixed(1)}MB / RSS: ${(mem.rss/1024/1024).toFixed(1)}MB`);
}

// Captura inicial
captureSnapshot('start');

// Verifica a cada 30s por 5 minutos
let count = 0;
const interval = setInterval(() => {
    count++;
    captureSnapshot(`check-${count}`);
    
    // Análise de crescimento
    if (count > 1) {
        const first = snapshots[0];
        const current = snapshots[snapshots.length - 1];
        const growth = ((current.heapUsed - first.heapUsed) / first.heapUsed * 100).toFixed(1);
        
        console.log(`  → Crescimento: ${growth}% em ${count * 30}s`);
        
        if (current.heapUsed / current.heapLimit > 0.9) {
            console.log('⚠️ CRÍTICO: Heap > 90%');
            fs.writeFileSync('memory-snapshots.json', JSON.stringify(snapshots, null, 2));
            console.log('💾 Snapshots salvos em memory-snapshots.json');
        }
    }
    
    if (count >= 10) {
        clearInterval(interval);
        fs.writeFileSync('memory-snapshots.json', JSON.stringify(snapshots, null, 2));
        console.log('\n✅ Monitoramento completo. Verifique memory-snapshots.json');
        process.exit(0);
    }
}, 30000);

console.log('🔍 Monitorando memória por 5 minutos...\n');
