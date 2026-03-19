#!/usr/bin/env node
/**
 * 🔐 Atualiza a chave GA4 no .env
 * 
 * INSTRUÇÕES:
 * 1. Cole a chave completa abaixo (dentro das aspas)
 * 2. Rode: node scripts/update-ga4-key.js
 * 3. Reinicie o servidor
 */

import fs from 'fs';
import path from 'path';

// ⬇️ COLE A CHAVE AQUI (já está formatada corretamente)
const NEW_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQClsDd/qDwLsccY
wKX5gpMyg8s8dSvFSt2FEXP0sEPQqtBU9a8vsc4xZfmNX263xjX4R8ahw088TCdf
NvkQ1nzJ32Dl2A6sPJPblK9dzwabMAqbOGpmuRkbI/obbVJ9bnx90Txsh3KMBGLk
ch0pD3PHLOSPGEeCeLMK5+rCFJAkfNbii1R5O4LIQloPMVxGyf3nu/8uGxbdlVWD
SVGBoM8BGv8aptdXidAl6ECDylFgTf2li9D8QGPBiklfvDmThwwxpogUJq/aMAwu
3hIYSCxQt4fMlMV94KnX6uIBfQx5VbYhPy0PCu0lv/vZhA+pRO/bHiVGBKLEs7Gh
HT/xCuUJAgMBAAECggEAD0FEOtqwfJsnq53BKlHdX59GzRA0sXuNHb1XocXA2KuB
dvEP6iJCy8WJznxk40K6oVtqbGZhGzofveJ/2A8Heka40zCrWSxSqLrt0oNHJm6r
61KsaTzNlPQhCPltyOKtT6A+IffukfmtaT8gdDFaBZKakJo5q0eVpIFp2eiuxM0b
xX4QDLFrMYt5Zn+qpKPikYOoZD1nj07lM9XdMxfGx05v9bnYVHuu3SXgoq7J1vse
CVj4Q+ZufFS8b3o33QHOAWqaFbilwyg6fM0oovKLmNenAJNCVGN2ycR+t+Wnbp5s
auh4rtBxe3yZharmcGRrWY43YEyRCbscjva2xGtxaQKBgQDRuWx/HjkFio4wXCTd
BijUk3ksnyX43mYKF2+dTNjlGYS84END+Q+2CYTgJkrw14VsTVhzxM3/X6NiBYmg
Teqm7a5P7REcwrihiaoH+1+2HYMqT+vehG/dnLoqKSJ8ZGOazvGe2MP7LR32hS2z
aGKvhFTdwrEXdVCnsZzowzTq3wKBgQDKP1vcnuoOd7bsRHDUQvul1U/kzlnYeO3E
ThtV+rNMy/VTG1dawi2XvgAxawN4YzzxNUiX+4LsB3tyq8xLaQIs9Nx+ZZbpZRtd
366BaTmkeHndsH5aTcryMWC5Wxh9vfpg2BPfh/E7SWiz3BVb2/UvMyqmhqNVaoiI
Be7qLiqVFwKBgQDMXGfp0pRz3tjBLPjK2zasNewM3CPPRz+dM8sSN5DeZahfuBQz
xx1VIB93oDjESO79Yrz/SlYFM7dsS8MZDvPJp6+EuJhFM0VgO1oRHxTbzBRFBc3s
bZboFtGdRaoSFmysrFzrkYQfXI5m6s1mliAbsdJUqWORXUKztbIVaipFdwKBgAd+
KW0XBhzbGo/OSU/T23bdXERh0LpQYJ6xNhoNW68wrzoQ/T+DiiThCSjLiilfo9Zb
3wCidMtBy7UH4F262jXILJMSOHEVKdpkexaYS2ZogDtSWpwF3crzQV4cnd+qtif4
WWQiqTFFGvfu42uvznmdL6tTuaFkfQJtFdjfNPypAoGBAIGMTAHG8cvOu3E0SpER
BYK1JGJnGRM2WAbdlQKIOz7BrbEI+hwmZKAjjmIJY7q+Pli0+pd/yOMF8OuS1Rs9
9TH9vBK8Pn48Rkl6ikqvU4df6K9ebWqPEREhZzMOk4Y4YKFAaITLUHEB2HQ9U79s
FGaaq+6t3oeOXbpWNdwR9RAn
-----END PRIVATE KEY-----`;

console.log('🔐 Atualizando chave GA4...\n');

const envPath = path.resolve('.env');

if (!fs.existsSync(envPath)) {
    console.error('❌ Arquivo .env não encontrado!');
    process.exit(1);
}

let envContent = fs.readFileSync(envPath, 'utf-8');

// Verificar se a chave já está atualizada
if (envContent.includes(NEW_PRIVATE_KEY.substring(0, 50))) {
    console.log('✅ Chave já está atualizada!');
    process.exit(0);
}

// Preparar a chave para o formato .env (escapar newlines)
const escapedKey = NEW_PRIVATE_KEY.replace(/\n/g, '\\n');

// Substituir a chave antiga
const keyRegex = /GA4_PRIVATE_KEY=.*/;
if (keyRegex.test(envContent)) {
    envContent = envContent.replace(keyRegex, `GA4_PRIVATE_KEY="${escapedKey}"`);
    console.log('✅ Chave atualizada no .env');
} else {
    // Adicionar se não existir
    envContent += `\nGA4_PRIVATE_KEY="${escapedKey}"\n`;
    console.log('✅ Chave adicionada ao .env');
}

fs.writeFileSync(envPath, envContent);

console.log('\n📊 Informações da nova chave:');
console.log('  Tamanho:', NEW_PRIVATE_KEY.length, 'caracteres ✅');
console.log('  Formato:', NEW_PRIVATE_KEY.includes('BEGIN PRIVATE KEY') ? '✅ Válido' : '❌ Inválido');

console.log('\n🚀 Próximos passos:');
console.log('  1. Reinicie o servidor: npm run dev');
console.log('  2. Teste: node scripts/test-ga4-real.js');
