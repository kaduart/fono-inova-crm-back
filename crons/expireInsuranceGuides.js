// crons/expireInsuranceGuides.js
import InsuranceGuide from '../models/InsuranceGuide.js';

/**
 * 🕒 Job de Expiração de Guias de Convênio
 *
 * Tarefa diária que marca guias vencidas como 'expired'.
 * Deve ser executado via node-cron ou agendador existente.
 *
 * Frequência recomendada: Diariamente às 00:00
 *
 * @example
 * // Usando node-cron
 * import cron from 'node-cron';
 * cron.schedule('0 0 * * *', expireInsuranceGuides);
 */
export async function expireInsuranceGuides() {
  try {
    const now = new Date();

    console.log(`[CRON] Iniciando job de expiração de guias: ${now.toISOString()}`);

    // Buscar guias ativas com data de validade vencida
    const result = await InsuranceGuide.updateMany(
      {
        status: 'active',
        expiresAt: { $lt: now }
      },
      {
        $set: { status: 'expired' }
      }
    );

    if (result.modifiedCount > 0) {
      console.log(`[CRON] ✅ ${result.modifiedCount} guia(s) marcada(s) como expirada(s)`);
    } else {
      console.log('[CRON] ℹ️  Nenhuma guia expirada encontrada');
    }

    return {
      success: true,
      expired: result.modifiedCount,
      executedAt: now
    };

  } catch (error) {
    console.error('[CRON] ❌ Erro ao expirar guias:', error);
    return {
      success: false,
      error: error.message,
      executedAt: new Date()
    };
  }
}

/**
 * Executa o job imediatamente (para testes)
 */
export async function runNow() {
  console.log('Executando job de expiração de guias manualmente...');
  const result = await expireInsuranceGuides();
  console.log('Resultado:', result);
  return result;
}

// Se executado diretamente (node crons/expireInsuranceGuides.js)
if (import.meta.url === `file://${process.argv[1]}`) {
  import('../config/database.js').then(async () => {
    await runNow();
    process.exit(0);
  });
}
