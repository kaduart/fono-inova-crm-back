#!/usr/bin/env node
// scripts/rebuild-payments-projection.js
/**
 * Script para reconstituir a projection de payments
 * Executar: node scripts/rebuild-payments-projection.js
 */

import dotenv from 'dotenv';
dotenv.config();

import mongoose from 'mongoose';

// Importar todos os models necessários
import '../models/Patient.js';
import '../models/Doctor.js';
import '../models/Appointment.js';
import '../models/Package.js';
import '../models/Session.js';
import '../models/Payment.js';
import '../models/PaymentsView.js';

import { rebuildPaymentsProjection } from '../projections/paymentsProjection.js';

async function main() {
    try {
        console.log('🔌 Conectando ao MongoDB...');
        await mongoose.connect(process.env.MONGO_URI);
        console.log(`✅ Conectado: ${mongoose.connection.db.databaseName}\n`);
        
        const clinicId = process.argv[2] || 'default';
        
        console.log(`🚀 Iniciando rebuild da projection para clinic: ${clinicId}\n`);
        
        const startTime = Date.now();
        const result = await rebuildPaymentsProjection(clinicId);
        const duration = Date.now() - startTime;
        
        console.log(`\n✅ Rebuild completo!`);
        console.log(`   Processados: ${result.processed}/${result.total}`);
        console.log(`   Duração: ${(duration / 1000).toFixed(2)}s`);
        console.log(`   Velocidade: ${(result.processed / (duration / 1000)).toFixed(1)} docs/s`);
        
    } catch (error) {
        console.error('\n❌ Erro:', error.message);
        process.exit(1);
    } finally {
        await mongoose.disconnect();
        console.log('\n🔌 Desconectado');
    }
}

main();
