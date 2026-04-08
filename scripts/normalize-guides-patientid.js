// Padroniza TODAS as guias para usar STRING no patientId
// Converte ObjectId -> String

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

async function normalize() {
    try {
        await mongoose.connect(process.env.MONGO_URI || 'mongodb+srv://kaduart:%40Soundcar10@cluster0.g2c3sdk.mongodb.net/test');
        console.log('✅ Conectado ao MongoDB\n');

        const InsuranceGuide = mongoose.model('InsuranceGuide', new mongoose.Schema({}, { strict: false }));
        
        // Buscar guias com patientId como ObjectId
        const guides = await InsuranceGuide.find({
            patientId: { $type: 'objectId' }
        });
        
        console.log(`📋 Encontradas ${guides.length} guias com ObjectId\n`);
        
        let converted = 0;
        for (const guide of guides) {
            const oldId = guide.patientId;
            const newId = guide.patientId.toString();
            
            await InsuranceGuide.updateOne(
                { _id: guide._id },
                { $set: { patientId: newId } }
            );
            
            console.log(`✅ Convertida: ${guide.number} | ${oldId} -> ${newId}`);
            converted++;
        }
        
        console.log(`\n🎉 ${converted} guias padronizadas para STRING!`);
        
    } catch (error) {
        console.error('❌ Erro:', error.message);
    } finally {
        await mongoose.disconnect();
        console.log('\n👋 Desconectado');
    }
}

normalize();
