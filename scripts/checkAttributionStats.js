/**
 * 📊 Script de Verificação: Estatísticas de Atribuição
 * 
 * Mostra o estado atual dos appointments e leads para diagnóstico
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Appointment from '../models/Appointment.js';
import Leads from '../models/Leads.js';

// Carregar .env (assume que está na pasta back/ ou raiz)
dotenv.config();

async function connectDB() {
  // Tenta MONGO_URI ou MONGODB_URI
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error('❌ MONGO_URI não encontrado no .env');
    console.error('   Verifique se o arquivo .env existe em /back/.env');
    console.error('   e se contém a variável MONGO_URI');
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log('✅ Conectado ao MongoDB\n');
}

async function showStats() {
  await connectDB();
  
  try {
    // Total de appointments
    const totalAppointments = await Appointment.countDocuments();
    
    // Appointments com lead vinculado
    const withLead = await Appointment.countDocuments({ 
      lead: { $exists: true, $ne: null } 
    });
    
    // Appointments SEM lead
    const withoutLead = await Appointment.countDocuments({
      $or: [
        { lead: { $exists: false } },
        { lead: null }
      ]
    });
    
    // Appointments com leadSnapshot
    const withSnapshot = await Appointment.countDocuments({
      'leadSnapshot.source': { $exists: true, $ne: null }
    });
    
    // Total de leads
    const totalLeads = await Leads.countDocuments();
    
    // Leads convertidos (viraram paciente)
    const convertedLeads = await Leads.countDocuments({
      convertedToPatient: { $exists: true, $ne: null }
    });
    
    // Leads com source
    const leadsWithSource = await Leads.countDocuments({
      $or: [
        { source: { $exists: true, $ne: null } },
        { origin: { $exists: true, $ne: null } }
      ]
    });
    
    // Top sources de leads
    const topSources = await Leads.aggregate([
      {
        $group: {
          _id: { $ifNull: ['$source', '$origin', 'desconhecido'] },
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);
    
    // Top sources em appointments (leadSnapshot)
    const topAppointmentSources = await Appointment.aggregate([
      {
        $match: { 'leadSnapshot.source': { $exists: true, $ne: null } }
      },
      {
        $group: {
          _id: '$leadSnapshot.source',
          count: { $sum: 1 },
          revenue: { $sum: '$sessionValue' }
        }
      },
      { $sort: { count: -1 } }
    ]);
    
    console.log(`${'='.repeat(60)}`);
    console.log('📊 ESTATÍSTICAS DE ATRIBUIÇÃO');
    console.log(`${'='.repeat(60)}\n`);
    
    console.log('📋 APPOINTMENTS');
    console.log(`  Total: ${totalAppointments}`);
    console.log(`  Com lead vinculado: ${withLead} (${((withLead/totalAppointments)*100).toFixed(1)}%)`);
    console.log(`  Sem lead: ${withoutLead} (${((withoutLead/totalAppointments)*100).toFixed(1)}%)`);
    console.log(`  Com leadSnapshot: ${withSnapshot}`);
    console.log();
    
    console.log('👥 LEADS');
    console.log(`  Total: ${totalLeads}`);
    console.log(`  Convertidos (viraram paciente): ${convertedLeads}`);
    console.log(`  Com source/origin: ${leadsWithSource}`);
    console.log();
    
    console.log('🔝 TOP 10 ORIGENS DE LEADS');
    topSources.forEach((item, i) => {
      console.log(`  ${i+1}. ${item._id}: ${item.count} leads`);
    });
    console.log();
    
    console.log('🔝 TOP ORIGENS EM APPOINTMENTS (com atribuição)');
    if (topAppointmentSources.length === 0) {
      console.log('  (Nenhum appointment com leadSnapshot ainda)');
    } else {
      topAppointmentSources.forEach((item, i) => {
        console.log(`  ${i+1}. ${item._id}: ${item.count} appointments, R$ ${item.revenue.toLocaleString('pt-BR')}`);
      });
    }
    console.log();
    
    console.log(`${'='.repeat(60)}`);
    console.log('📋 RECOMENDAÇÃO');
    if (withoutLead > 0) {
      console.log(`\nHá ${withoutLead} appointments sem atribuição.`);
      console.log('Execute a migração para vincular aos leads:');
      console.log('  node scripts/migrateAppointmentLeadAttribution.js --dry-run');
    } else {
      console.log('\n✅ Todos os appointments já têm atribuição!');
    }
    console.log(`${'='.repeat(60)}`);
    
  } catch (error) {
    console.error('❌ Erro:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n👋 Desconectado');
  }
}

showStats().catch(console.error);
