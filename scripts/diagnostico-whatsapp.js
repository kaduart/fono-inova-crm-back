/**
 * 🔍 Diagnóstico Rápido do Sistema WhatsApp
 */

import mongoose from 'mongoose';
import { redisConnection } from '../config/redisConnection.js';
import Lead from '../models/Leads.js';
import Message from '../models/Message.js';
import dotenv from 'dotenv';

dotenv.config();

async function diagnostico() {
    console.log('═══════════════════════════════════════════════════');
    console.log('🔍 DIAGNÓSTICO DO SISTEMA WHATSAPP');
    console.log('═══════════════════════════════════════════════════\n');

    // 1. Verifica MongoDB
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('✅ MongoDB: Conectado');
        
        // Última mensagem
        const lastMsg = await Message.findOne().sort({ timestamp: -1 });
        if (lastMsg) {
            const minutosAtras = Math.floor((Date.now() - lastMsg.timestamp) / (1000 * 60));
            console.log(`📩 Última mensagem: ${minutosAtras} minutos atrás`);
            console.log(`   De: ${lastMsg.from} | Tipo: ${lastMsg.direction}`);
        } else {
            console.log('⚠️ Nenhuma mensagem encontrada no banco');
        }
        
        // Último lead
        const lastLead = await Lead.findOne().sort({ lastInteractionAt: -1 });
        if (lastLead) {
            const minutosAtras = Math.floor((Date.now() - lastLead.lastInteractionAt) / (1000 * 60));
            console.log(`👤 Último lead ativo: ${minutosAtras} minutos atrás (${lastLead.contact?.phone})`);
        }
        
        // Total leads novos hoje
        const hoje = new Date();
        hoje.setHours(0, 0, 0, 0);
        const leadsHoje = await Lead.countDocuments({ createdAt: { $gte: hoje } });
        console.log(`📊 Leads criados hoje: ${leadsHoje}`);
        
    } catch (err) {
        console.log('❌ MongoDB:', err.message);
    }

    // 2. Verifica Redis
    console.log('\n───────────────────────────────────────────────────');
    try {
        await redisConnection.ping();
        console.log('✅ Redis: Conectado');
        
        // Verifica filas
        const queues = ['whatsapp-inbound', 'whatsapp-lead-state', 'whatsapp-orchestrator'];
        for (const queue of queues) {
            const count = await redisConnection.llen(`bull:${queue}:wait`);
            console.log(`📦 Fila ${queue}: ${count} jobs pendentes`);
        }
    } catch (err) {
        console.log('❌ Redis:', err.message);
    }

    // 3. Configurações Webhook
    console.log('\n───────────────────────────────────────────────────');
    console.log('🔧 Configurações:');
    console.log(`   WEBHOOK_URL: ${process.env.WEBHOOK_URL || 'NÃO CONFIGURADO'}`);
    console.log(`   VERIFY_TOKEN: ${process.env.WHATSAPP_VERIFY_TOKEN ? '***' : 'NÃO CONFIGURADO'}`);
    console.log(`   PHONE_NUMBER_ID: ${process.env.WHATSAPP_PHONE_NUMBER_ID || 'NÃO CONFIGURADO'}`);

    console.log('\n═══════════════════════════════════════════════════');
    console.log('✅ Diagnóstico concluído');
    console.log('═══════════════════════════════════════════════════');
    
    await mongoose.disconnect();
    process.exit(0);
}

diagnostico();
