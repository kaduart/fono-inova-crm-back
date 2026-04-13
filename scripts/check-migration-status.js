#!/usr/bin/env node
/**
 * 🔍 Script de Monitoramento de Migração V1 → V2
 * 
 * Executa: node scripts/check-migration-status.js
 * 
 * Retorna:
 * - Status da migração
 * - Recomendação de ação
 * - Lista de packages V1 ainda ativos
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Cores para terminal
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m'
};

async function checkMigrationStatus() {
  try {
    console.log(`${colors.cyan}${colors.bold}🔍 Verificando status de migração V1 → V2...${colors.reset}\n`);
    
    // Conecta ao MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Conectado ao MongoDB\n');
    
    const Package = mongoose.model('Package');
    
    // Contagem total
    const v1Total = await Package.countDocuments({ model: { $exists: false } });
    const v2Total = await Package.countDocuments({ model: { $exists: true } });
    const total = v1Total + v2Total;
    
    // Contagem por status
    const v1Active = await Package.countDocuments({ 
      model: { $exists: false },
      status: { $in: ['active', 'in-progress'] }
    });
    
    const v1Completed = await Package.countDocuments({
      model: { $exists: false },
      status: 'completed'
    });
    
    // Atividade recente (30 dias)
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    
    const v1Recent = await Package.countDocuments({
      model: { $exists: false },
      updatedAt: { $gte: thirtyDaysAgo }
    });
    
    // Métricas
    const migrationPercent = total > 0 ? Math.round((v2Total / total) * 100) : 100;
    
    // Print resumo
    console.log(`${colors.bold}📊 RESUMO DA MIGRAÇÃO${colors.reset}`);
    console.log('─'.repeat(50));
    console.log(`Total de packages:     ${total}`);
    console.log(`V1 (sem model):        ${colors.yellow}${v1Total}${colors.reset}`);
    console.log(`V2 (com model):        ${colors.green}${v2Total}${colors.reset}`);
    console.log(`Percentual V2:         ${migrationPercent}%`);
    console.log('─'.repeat(50));
    
    console.log(`\n${colors.bold}📦 PACKAGES V1 (LEGADO)${colors.reset}`);
    console.log('─'.repeat(50));
    console.log(`Ativos:                ${v1Active > 0 ? colors.red + v1Active + colors.reset : colors.green + v1Active + colors.reset}`);
    console.log(`Concluídos:            ${v1Completed}`);
    console.log(`Com atividade recente: ${v1Recent > 0 ? colors.yellow + v1Recent + colors.reset : colors.green + v1Recent + colors.reset}`);
    console.log('─'.repeat(50));
    
    // Recomendação
    console.log(`\n${colors.bold}🎯 RECOMENDAÇÃO${colors.reset}`);
    console.log('─'.repeat(50));
    
    if (v1Active === 0 && v1Total === 0) {
      console.log(`${colors.green}✅ V1 TOTALMENTE MIGRADO${colors.reset}`);
      console.log('→ Pode desativar V1 com segurança');
      console.log('→ Não há risco operacional');
    } else if (v1Active === 0 && v1Total > 0) {
      console.log(`${colors.green}✅ PRONTO PARA LIMPEZA${colors.reset}`);
      console.log('→ Não há packages V1 ativos');
      console.log('→ Podem ser arquivados/migrados manualmente');
      console.log(`→ ${v1Completed} packages concluídos podem ser arquivados`);
    } else if (v1Active <= 5) {
      console.log(`${colors.yellow}⚠️ QUASE LÁ${colors.reset}`);
      console.log(`→ ${v1Active} packages V1 ainda ativos`);
      console.log('→ Aguardar conclusão ou migrar manualmente');
      console.log('→ NÃO desative V1 ainda');
    } else {
      console.log(`${colors.red}⏳ AGUARDAR${colors.reset}`);
      console.log(`→ ${v1Active} packages V1 ainda ativos`);
      console.log('→ Muitos pacientes ainda dependem de V1');
      console.log('→ Desativar agora = QUEBRA OPERACIONAL');
    }
    
    console.log('─'.repeat(50));
    
    // Lista packages V1 ativos (se houver)
    if (v1Active > 0) {
      console.log(`\n${colors.bold}📋 PACKAGES V1 ATIVOS (top 10)${colors.reset}`);
      console.log('─'.repeat(80));
      
      const activePackages = await Package.find({
        model: { $exists: false },
        status: { $in: ['active', 'in-progress'] }
      })
      .sort({ updatedAt: -1 })
      .limit(10)
      .populate('patient', 'fullName')
      .lean();
      
      console.log(`${'Paciente'.padEnd(30)} ${'Status'.padEnd(12)} ${'Sessões'.padEnd(10)} ${'Atualizado'.padEnd(20)}`);
      console.log('─'.repeat(80));
      
      for (const pkg of activePackages) {
        const patientName = (pkg.patient?.fullName || 'Desconhecido').substring(0, 28).padEnd(30);
        const status = pkg.status.padEnd(12);
        const sessions = `${pkg.sessionsDone || 0}/${pkg.totalSessions}`.padEnd(10);
        const updated = pkg.updatedAt.toISOString().split('T')[0].padEnd(20);
        console.log(`${patientName} ${status} ${sessions} ${updated}`);
      }
      
      if (v1Active > 10) {
        console.log(`... e mais ${v1Active - 10} packages`);
      }
      
      console.log('─'.repeat(80));
    }
    
    // Próximos passos
    console.log(`\n${colors.bold}📌 PRÓXIMOS PASSOS${colors.reset}`);
    console.log('─'.repeat(50));
    
    if (v1Active > 0) {
      console.log('1. Monitore: GET /api/health/migration');
      console.log('2. Liste: GET /api/health/migration/packages-v1');
      console.log('3. Migre manualmente os packages críticos');
      console.log('4. Aguarde conclusão natural dos demais');
      console.log('5. Quando v1Active = 0, pode desativar V1');
    } else {
      console.log('1. Verifique se há webhooks/integrações V1 ativas');
      console.log('2. Arquive packages V1 concluídos');
      console.log('3. Documente a desativação de V1');
      console.log('4. Desative as rotas V1 (comunicar time!)');
    }
    
    console.log('─'.repeat(50));
    console.log(`\n${colors.cyan}Endpoints úteis:${colors.reset}`);
    console.log('  GET /api/health/migration');
    console.log('  GET /api/health/migration/packages-v1');
    console.log();
    
    await mongoose.disconnect();
    console.log('✅ Desconectado do MongoDB');
    
    // Exit code baseado no status
    process.exit(v1Active === 0 ? 0 : 1);
    
  } catch (error) {
    console.error(`${colors.red}❌ Erro:${colors.reset}`, error.message);
    process.exit(1);
  }
}

checkMigrationStatus();
