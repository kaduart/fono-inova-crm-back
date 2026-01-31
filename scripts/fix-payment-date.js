/**
 * Script para corrigir a data de um pagamento específico
 * Uso: node scripts/fix-payment-date.js
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Carrega .env da raiz do backend ANTES de tudo
dotenv.config({ path: join(__dirname, '../.env') });
// Configurações
const PAYMENT_ID = '697926085c9fa421c76aad65'; // ID do pagamento da Isis (R$ 160)
const CORRECT_DATE = '2026-01-27'; // Data correta (terça-feira)

async function fixPaymentDate() {
    try {
        // Verificar se MONGO_URI está definida
        const mongoUri = process.env.MONGO_URI;

        if (!mongoUri) {
            console.error('❌ Erro: MONGO_URI não encontrada no .env');
            console.log('\n💡 Verifique se o arquivo .env existe na pasta backend/');
            console.log('   Ou defina manualmente:');
            console.log('   export MONGO_URI="mongodb+srv://usuario:senha@cluster.mongodb.net/fono-inova"');
            process.exit(1);
        }

        // Importa o modelo dinamicamente (depois do dotenv carregado)
        const { default: Payment } = await import('../models/Payment.js');

        // Conectar ao MongoDB
        await mongoose.connect(mongoUri);
        console.log('✅ Conectado ao MongoDB');

        // Buscar o pagamento
        const payment = await Payment.findById(PAYMENT_ID);

        if (!payment) {
            console.log('❌ Pagamento não encontrado');
            process.exit(1);
        }

        console.log('\n📋 Pagamento encontrado:');
        console.log(`   ID: ${payment._id}`);
        console.log(`   Paciente: ${payment.patient}`);
        console.log(`   Valor: R$ ${payment.amount}`);
        console.log(`   Status: ${payment.status}`);
        console.log(`   Data atual (paymentDate): ${payment.paymentDate || 'N/A'}`);
        console.log(`   Criado em: ${payment.createdAt}`);

        // Atualizar para a data correta
        const result = await Payment.findByIdAndUpdate(
            PAYMENT_ID,
            {
                $set: {
                    paymentDate: CORRECT_DATE,
                    updatedAt: new Date()
                }
            },
            { new: true }
        );

        console.log('\n✅ Pagamento atualizado com sucesso!');
        console.log(`   Nova paymentDate: ${result.paymentDate}`);
        console.log(`\n💡 O pagamento agora aparecerá no caixa de ${CORRECT_DATE}`);

        await mongoose.disconnect();
        console.log('\n🔌 Desconectado do MongoDB');
        process.exit(0);

    } catch (error) {
        console.error('❌ Erro:', error.message);
        process.exit(1);
    }
}

fixPaymentDate();
