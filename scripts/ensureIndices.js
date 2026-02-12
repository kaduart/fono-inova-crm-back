// backend/scripts/ensureIndices.js
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const ensureIndices = async () => {
    try {
        console.log('🔗 Conectando ao MongoDB para garantir índices...');
        await mongoose.connect(process.env.MONGO_URI);

        const db = mongoose.connection.db;

        console.log('🚀 Criando índices para Performance de Analytics...');

        // Pagamentos
        await db.collection('payments').createIndex({ status: 1, paidAt: -1 });
        await db.collection('payments').createIndex({ sessionType: 1, status: 1, paidAt: -1 });
        await db.collection('payments').createIndex({ doctor: 1, status: 1, paidAt: -1 });
        await db.collection('payments').createIndex({ patient: 1, status: 1, paidAt: -1 });

        // 🟠 NOVO ÍNDICE SUGERIDO NO PR REVIEW
        await db.collection('payments').createIndex({ appointment: 1 }, { name: 'payment_appointment_idx' });

        // Agendamentos
        await db.collection('appointments').createIndex({ patient: 1, date: -1 });

        // Pacotes
        await db.collection('packages').createIndex({ patient: 1, status: 1 });
        await db.collection('packages').createIndex({ status: 1, sessionsDone: 1, totalSessions: 1 });

        console.log('✅ Todos os índices foram criados/verificados com sucesso!');
        process.exit(0);
    } catch (error) {
        console.error('❌ Erro ao criar índices:', error);
        process.exit(1);
    }
};

ensureIndices();
