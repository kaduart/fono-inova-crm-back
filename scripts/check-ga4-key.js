#!/usr/bin/env node
/**
 * 🔍 Verificador de chave GA4
 * Verifica se a chave está completa e válida
 */

import dotenv from 'dotenv';
dotenv.config();

const key = process.env.GA4_PRIVATE_KEY;

console.log('🔐 Verificação da Chave GA4\n');
console.log('==========================\n');

if (!key) {
    console.log('❌ GA4_PRIVATE_KEY não encontrada!');
    process.exit(1);
}

// Limpar a chave como o sistema faz
let cleanKey = key;
if (cleanKey?.startsWith('"')) cleanKey = cleanKey.slice(1);
if (cleanKey?.endsWith('"')) cleanKey = cleanKey.slice(0, -1);
if (cleanKey?.startsWith('\"') && cleanKey?.endsWith('\"')) {
    cleanKey = cleanKey.slice(1, -1);
}
cleanKey = cleanKey?.replace(/\\\\n/g, '\n');
cleanKey = cleanKey?.replace(/\\n/g, '\n');

console.log('✅ Chave encontrada!');
console.log('');
console.log('Tamanho:', cleanKey.length, 'caracteres');
console.log('Status:', cleanKey.length > 1000 ? '✅ Parece COMPLETA' : '❌ Parece INCOMPLETA (truncada)');
console.log('');
console.log('Primeiros 50 caracteres:');
console.log(cleanKey.substring(0, 50));
console.log('');
console.log('Últimos 50 caracteres:');
console.log(cleanKey.substring(cleanKey.length - 50));
console.log('');
console.log('Número de linhas:', cleanKey.split('\n').length);
console.log('');

// Verificar formato
const hasBegin = cleanKey.includes('-----BEGIN PRIVATE KEY-----');
const hasEnd = cleanKey.includes('-----END PRIVATE KEY-----');
const hasNewlines = cleanKey.includes('\n');

console.log('Formato:');
console.log('  ✓ BEGIN PRIVATE KEY:', hasBegin ? '✅' : '❌');
console.log('  ✓ END PRIVATE KEY:', hasEnd ? '✅' : '❌');
console.log('  ✓ Newlines:', hasNewlines ? '✅' : '❌');
console.log('');

if (cleanKey.length > 1000 && hasBegin && hasEnd) {
    console.log('✅ Chave parece válida!');
} else {
    console.log('❌ Chave parece inválida ou incompleta!');
    console.log('   - Tamanho esperado: ~1700 caracteres');
    console.log('   - Tamanho atual:', cleanKey.length, 'caracteres');
}
