// scripts/migratePatientsViewPackages.js
// 🚀 Migração: Adiciona campo packages em views existentes

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import PatientsView from '../models/PatientsView.js';
import { buildPatientView } from '../domains/clinical/services/patientProjectionService.js';

dotenv.config();

async function migrate() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Conectado ao MongoDB');

    // 1. Busca todas as views que não têm o campo packages
    const viewsWithoutPackages = await PatientsView.find({
      packages: { $exists: false }
    });

    console.log(`📊 Encontradas ${viewsWithoutPackages.length} views sem campo packages`);

    if (viewsWithoutPackages.length === 0) {
      console.log('✅ Todas as views já têm o campo packages');
      return;
    }

    // 2. Marca como stale para rebuild
    console.log('🔄 Marcando views como stale para rebuild...');
    
    const result = await PatientsView.updateMany(
      { packages: { $exists: false } },
      {
        $set: {
          'snapshot.isStale': true,
          packages: [] // Adiciona array vazio temporariamente
        }
      }
    );

    console.log(`✅ ${result.modifiedCount} views marcadas para rebuild`);

    // 3. Opcional: Rebuild síncrono das primeiras 10 views (para teste)
    const rebuildCount = Math.min(10, viewsWithoutPackages.length);
    console.log(`🔄 Reconstruindo ${rebuildCount} views síncronas...`);

    for (let i = 0; i < rebuildCount; i++) {
      const view = viewsWithoutPackages[i];
      try {
        await buildPatientView(view.patientId.toString(), {
          correlationId: `migration_${i}`
        });
        console.log(`  ✅ ${i + 1}/${rebuildCount} - ${view.fullName}`);
      } catch (err) {
        console.error(`  ❌ ${i + 1}/${rebuildCount} - ${view.fullName}: ${err.message}`);
      }
    }

    console.log('\n📋 Resumo:');
    console.log(`  - Total views sem packages: ${viewsWithoutPackages.length}`);
    console.log(`  - Views marcadas para rebuild: ${result.modifiedCount}`);
    console.log(`  - Views reconstruídas agora: ${rebuildCount}`);
    console.log(`  - Views restantes serão atualizadas no próximo acesso`);

    await mongoose.disconnect();
    console.log('\n✅ Migração concluída!');

  } catch (error) {
    console.error('❌ Erro na migração:', error);
    process.exit(1);
  }
}

migrate();
