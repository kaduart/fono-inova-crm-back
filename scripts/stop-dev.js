#!/usr/bin/env node
/**
 * Stop Dev Script
 * Para o servidor em modo desenvolvimento
 */

import { execSync } from 'child_process';

console.log('🛑 Parando servidor de desenvolvimento...');

try {
    // Mata processos nodemon
    try {
        execSync('pkill -f nodemon', { stdio: 'ignore' });
        console.log('✅ Nodemon parado');
    } catch (e) {
        // ignorar se não estiver rodando
    }
    
    // Mata processos node server.js
    try {
        execSync('pkill -f "node server.js"', { stdio: 'ignore' });
        console.log('✅ Servidor parado');
    } catch (e) {
        // ignorar se não estiver rodando
    }
    
    console.log('✅ Servidor de desenvolvimento parado com sucesso');
} catch (error) {
    console.error('❌ Erro ao parar servidor:', error.message);
    process.exit(1);
}
