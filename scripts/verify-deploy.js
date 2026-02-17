#!/usr/bin/env node
/**
 * Script para verificar se todas as rotas estão registradas
 * Execute: node scripts/verify-deploy.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🔍 Verificando rotas registradas no server.js...\n');

const serverPath = path.join(__dirname, '..', 'server.js');
const serverContent = fs.readFileSync(serverPath, 'utf8');

// Extrai todas as rotas app.use('/api/...'
const routeMatches = serverContent.matchAll(/app\.use\(['"](\/api\/[^'"]+)['"],\s*(\w+)\)/g);
const routes = [...routeMatches].map(m => ({ path: m[1], handler: m[2] }));

console.log('📋 Rotas encontradas no server.js:');
routes.forEach(r => console.log(`  ✅ ${r.path} -> ${r.handler}`));

// Verifica se reminder está incluído
const hasReminder = routes.some(r => r.path === '/api/reminders');

console.log('\n' + (hasReminder ? '✅ Rota /api/reminders está registrada' : '❌ Rota /api/reminders NÃO encontrada'));

// Lista arquivos de rotas existentes
const routesDir = path.join(__dirname, '..', 'routes');
const routeFiles = fs.readdirSync(routesDir).filter(f => f.endsWith('.js'));

console.log('\n📁 Arquivos em routes/:');
routeFiles.forEach(f => {
  const isRegistered = routes.some(r => f.replace('.js', '') + 'Routes' === r.handler || 
                                        f.replace('.js', '') === r.handler);
  console.log(`  ${isRegistered ? '✅' : '⚠️'} ${f}`);
});

console.log('\n⚠️  Se alguma rota aparecer com ⚠️, ela existe mas NÃO está registrada no server.js');
console.log('   Execute o deploy novamente no Render para atualizar o backend.\n');
