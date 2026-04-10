#!/usr/bin/env node
/**
 * Start Dev Script
 * Inicia o servidor em modo desenvolvimento com auto-reload
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const rootDir = join(__dirname, '..');

console.log('🚀 Iniciando servidor em modo desenvolvimento...');

// Usa nodemon se disponível, senão node normal
const nodemon = spawn('npx', ['nodemon', 'server.js'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: true
});

nodemon.on('error', (err) => {
    console.error('❌ Erro ao iniciar nodemon:', err.message);
    console.log('🔄 Tentando com node direto...');
    
    const node = spawn('node', ['server.js'], {
        cwd: rootDir,
        stdio: 'inherit'
    });
    
    node.on('close', (code) => {
        process.exit(code);
    });
});

nodemon.on('close', (code) => {
    process.exit(code);
});
