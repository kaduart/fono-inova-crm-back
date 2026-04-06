/**
 * Script de diagnóstico: Mostra TODOS os pagamentos de abril 2026
 */
import mongoose from 'mongoose';
import moment from 'moment-timezone';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, '../.env') });

const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;

async function debugAbril() {
    if (!MONGO_URI) {
        console.error('❌ MONGO_URI não definido!');
        process.exit(1);
    }

    await mongoose.connect(MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    const db = mongoose.connection.db;
    const payments = db.collection('payments');

    // Busca TODOS os pagamentos de abril (usando String para pegar legado)
    const startStr = '2026-04-01';
    const endStr = '2026-04-30';

    console.log('🔍 Buscando pagamentos de abril (String format)...');
    const pagamentosString = await payments.find({
        status: { $ne: 'canceled' },
        paymentDate: { $gte: startStr, $lte: endStr }
    }).toArray();

    console.log(`📊 Encontrados ${pagamentosString.length} pagamentos (String):`);
    console.log('='.repeat(80));

    let totalString = 0;
    pagamentosString.forEach((p, i) => {
        totalString += p.amount || 0;
        console.log(`${i + 1}. ${p.paymentDate} | R$ ${(p.amount || 0).toFixed(2)} | ${p.status} | ${p.paymentMethod} | ${p.description?.substring(0, 30) || '-'}`);
        console.log(`   Tipo paymentDate: ${typeof p.paymentDate} | Valor: ${p.paymentDate}`);
    });
    console.log('='.repeat(80));
    console.log(`💰 TOTAL (String): R$ ${totalString.toFixed(2)}\n`);

    // Busca TODOS os pagamentos de abril (usando Date)
    console.log('🔍 Buscando pagamentos de abril (Date format)...');
    const startDate = new Date('2026-04-01T00:00:00.000Z');
    const endDate = new Date('2026-04-30T23:59:59.999Z');

    const pagamentosDate = await payments.find({
        status: { $ne: 'canceled' },
        paymentDate: { $gte: startDate, $lte: endDate }
    }).toArray();

    console.log(`📊 Encontrados ${pagamentosDate.length} pagamentos (Date):`);
    console.log('='.repeat(80));

    let totalDate = 0;
    pagamentosDate.forEach((p, i) => {
        totalDate += p.amount || 0;
        console.log(`${i + 1}. ${p.paymentDate} | R$ ${(p.amount || 0).toFixed(2)} | ${p.status} | ${p.paymentMethod}`);
    });
    console.log('='.repeat(80));
    console.log(`💰 TOTAL (Date): R$ ${totalDate.toFixed(2)}\n`);

    // Verifica createdAt de março
    console.log('🔍 Buscando pagamentos com createdAt em abril (para ver duplicados)...');
    const pagamentosCreated = await payments.find({
        status: { $ne: 'canceled' },
        createdAt: { $gte: startDate, $lte: endDate },
        paymentDate: { $lt: startStr } // paymentDate anterior a abril
    }).toArray();

    console.log(`📊 Encontrados ${pagamentosCreated.length} pagamentos com createdAt em abril mas paymentDate anterior:`);
    pagamentosCreated.forEach((p, i) => {
        console.log(`${i + 1}. createdAt: ${p.createdAt} | paymentDate: ${p.paymentDate} | R$ ${(p.amount || 0).toFixed(2)}`);
    });

    await mongoose.disconnect();
    process.exit(0);
}

debugAbril().catch(err => {
    console.error('❌ Erro:', err);
    process.exit(1);
});
