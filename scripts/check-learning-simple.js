// scripts/check-learning-simple.js
import fs from 'fs';

const file = './data/amanda_learning.json';

if (!fs.existsSync(file)) {
    console.log('❌ Nunca executou - arquivo não existe');
    process.exit(1);
}

const data = JSON.parse(fs.readFileSync(file, 'utf8'));
const lastUpdate = new Date(data.lastUpdate);
const horasAtras = Math.floor((new Date() - lastUpdate) / (1000 * 60 * 60));

console.log(`📅 Última execução: ${lastUpdate.toLocaleString('pt-BR')}`);
console.log(`⏰ Há ${horasAtras} horas atrás`);
console.log(`📊 Conversas analisadas: ${data.conversationsAnalyzed || 0}`);

if (horasAtras < 25) {
    console.log('✅ Executou hoje às 23h');
} else {
    console.log('⚠️ NÃO executou nas últimas 24h');
}