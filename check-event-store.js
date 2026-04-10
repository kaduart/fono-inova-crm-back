#!/usr/bin/env node
/**
 * 🔍 Verifica eventos no EventStore
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import EventStore from './models/EventStore.js';

dotenv.config();

const appointmentId = process.argv[2];

if (!appointmentId) {
    console.error('❌ Uso: node check-event-store.js <appointmentId>');
    process.exit(1);
}

async function checkEventStore() {
    console.log(`🔍 Verificando EventStore para: ${appointmentId}\n`);
    
    try {
        const MONGO_URI = process.env.MONGODB_URI || process.env.MONGO_URI;
        await mongoose.connect(MONGO_URI);
        
        // Busca eventos relacionados ao appointment
        const events = await EventStore.find({
            $or: [
                { 'payload.appointmentId': appointmentId },
                { aggregateId: appointmentId },
                { 'payload.payload.appointmentId': appointmentId }
            ]
        }).sort({ createdAt: -1 }).limit(10);
        
        console.log(`📊 ${events.length} eventos encontrados:\n`);
        
        events.forEach((evt, idx) => {
            console.log(`${idx + 1}. Evento ${evt.eventType}:`);
            console.log(`   ID: ${evt.eventId}`);
            console.log(`   Status: ${evt.status}`);
            console.log(`   Aggregate: ${evt.aggregateType} / ${evt.aggregateId}`);
            console.log(`   Criado em: ${evt.createdAt?.toLocaleString()}`);
            console.log(`   Payload:`, JSON.stringify(evt.payload, null, 2)?.substring(0, 200) + '...');
            console.log('');
        });
        
    } catch (err) {
        console.error('❌ Erro:', err.message);
    } finally {
        await mongoose.disconnect();
        process.exit(0);
    }
}

checkEventStore();
