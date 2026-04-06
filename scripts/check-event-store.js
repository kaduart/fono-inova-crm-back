// scripts/check-event-store.js
import mongoose from 'mongoose';
import EventStore from '../models/EventStore.js';

const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/crm';

async function checkEventStore() {
    console.log('🔍 Conectando ao MongoDB...\n');
    
    await mongoose.connect(mongoUri);
    console.log('✅ Conectado!\n');
    
    // Busca eventos de pagamento recentes
    const paymentEvents = await EventStore.find({
        eventType: { $regex: /PAYMENT/ }
    })
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();
    
    console.log(`📊 Eventos PAYMENT encontrados: ${paymentEvents.length}\n`);
    
    paymentEvents.forEach((evt, idx) => {
        console.log(`\n--- Evento ${idx + 1} ---`);
        console.log(`Tipo: ${evt.eventType}`);
        console.log(`ID: ${evt.eventId}`);
        console.log(`Status: ${evt.status}`);
        console.log(`Aggregate: ${evt.aggregateType} / ${evt.aggregateId}`);
        console.log(`Criado em: ${evt.createdAt}`);
        console.log(`Payload:`, JSON.stringify(evt.payload, null, 2).substring(0, 300));
    });
    
    // Conta por status
    const byStatus = await EventStore.aggregate([
        { $match: { eventType: { $regex: /PAYMENT/ } } },
        { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);
    
    console.log('\n📊 Eventos PAYMENT por status:');
    byStatus.forEach(s => console.log(`   ${s._id}: ${s.count}`));
    
    await mongoose.disconnect();
    process.exit(0);
}

checkEventStore().catch(err => {
    console.error('❌ Erro:', err);
    process.exit(1);
});
