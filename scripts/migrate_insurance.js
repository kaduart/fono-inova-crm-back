// Script para migrar convênios antigos que têm insurance: null
import mongoose from 'mongoose';
import Payment from '../models/Payment.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Carrega .env da raiz do backend
dotenv.config({ path: join(__dirname, '..', '.env') });

async function migrateInsurance() {
    const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI;
    
    if (!MONGO_URI) {
        console.error("❌ MONGO_URI não encontrado no .env");
        console.log("Variáveis disponíveis:");
        console.log(Object.keys(process.env).filter(k => k.includes('MONGO') || k.includes('DB')).join(', '));
        process.exit(1);
    }
    
    console.log("🔗 Conectando ao MongoDB...");
    await mongoose.connect(MONGO_URI);
    
    console.log("🔄 Migrando convênios com insurance: null...\n");
    
    // Buscar convênios com insurance null
    const conveniosSemInsurance = await Payment.find({
        billingType: 'convenio',
        $or: [
            { insurance: null },
            { insurance: { $exists: false } }
        ]
    });
    
    console.log(`📊 Encontrados ${conveniosSemInsurance.length} convênios sem dados de insurance`);
    
    // Para cada convênio, definir um valor padrão
    for (const convenio of conveniosSemInsurance) {
        console.log(`\n📝 Convênio: ${convenio._id}`);
        console.log(`   Paciente: ${convenio.patient}`);
        console.log(`   Data: ${convenio.paymentDate}`);
        console.log(`   Valor atual (amount): ${convenio.amount}`);
        
        // Atualizar com dados mínimos
        const grossAmount = convenio.amount > 0 ? convenio.amount : 0;
        
        await Payment.updateOne(
            { _id: convenio._id },
            {
                $set: {
                    insurance: {
                        provider: 'Não informado',
                        grossAmount: grossAmount,
                        status: convenio.status === 'paid' ? 'received' : 'pending_billing',
                        receivedAmount: convenio.status === 'paid' ? convenio.amount : 0
                    }
                }
            }
        );
        
        console.log(`   ✅ Atualizado! grossAmount: ${grossAmount}`);
    }
    
    console.log("\n✅ Migração concluída!");
    await mongoose.disconnect();
}

migrateInsurance().catch(err => {
    console.error("❌ Erro na migração:", err);
    process.exit(1);
});
