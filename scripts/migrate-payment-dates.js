/**
 * Script de migração: Converte paymentDate de String para Date
 * Uso: node scripts/migrate-payment-dates.js
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Carrega .env da raiz do back
dotenv.config({ path: join(__dirname, '../.env') });

import Payment from '../models/Payment.js';

async function migratePaymentDates() {
    const MONGODB_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
    
    if (!MONGODB_URI) {
        console.error('❌ ERRO: MONGODB_URI não definido!');
        console.log('Variáveis disponíveis:', Object.keys(process.env).filter(k => k.includes('MONGO')));
        process.exit(1);
    }
    
    try {
        await mongoose.connect(MONGODB_URI);
        console.log('✅ Conectado ao MongoDB');

        // Busca pagamentos onde paymentDate é string
        const stringPayments = await Payment.find({
            $or: [
                { paymentDate: { $type: 'string' } },
                { paymentDate: { $type: 2 } }
            ]
        });

        console.log(`Encontrados ${stringPayments.length} pagamentos com paymentDate como String`);

        let updated = 0;
        let errors = 0;

        for (const payment of stringPayments) {
            try {
                const dateStr = payment.paymentDate;
                let dateObj;

                if (typeof dateStr === 'string') {
                    // Formato YYYY-MM-DD -> Date
                    dateObj = new Date(dateStr + 'T12:00:00.000Z');
                } else {
                    dateObj = new Date(dateStr);
                }

                await Payment.updateOne(
                    { _id: payment._id },
                    { $set: { paymentDate: dateObj } }
                );
                updated++;

                if (updated % 100 === 0) {
                    console.log(`Progresso: ${updated}/${stringPayments.length}`);
                }
            } catch (err) {
                console.error(`Erro no pagamento ${payment._id}:`, err.message);
                errors++;
            }
        }

        console.log('\n✅ Migração concluída!');
        console.log(`Atualizados: ${updated}`);
        console.log(`Erros: ${errors}`);

    } catch (error) {
        console.error('Erro na migração:', error);
    } finally {
        await mongoose.disconnect();
        process.exit(0);
    }
}

migratePaymentDates();
