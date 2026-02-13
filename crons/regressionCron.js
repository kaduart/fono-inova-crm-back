
import cron from 'node-cron';
import { exec } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGRESSION_SCRIPT = join(__dirname, '..', 'tests', 'amanda', 'comprehensive_regression.js');

let isRunning = false;

/**
 * 🧪 INICIA O CRON DE REGRESSÃO
 * Roda diariamente às 00:00
 */
export function startRegressionCron() {
    console.log('🧪 [CRON] Inicializando cron de regressão...');

    // Agenda: 0 0 * * * = todo dia às 00:00
    cron.schedule('0 0 * * *', () => {
        if (isRunning) {
            console.log('⚠️ [CRON] Regressão anterior ainda em execução, pulando...');
            return;
        }

        isRunning = true;
        const startTime = Date.now();

        console.log('\n' + '═'.repeat(60));
        console.log('🧪 [CRON] INICIANDO TESTES DE REGRESSÃO DIÁRIOS');
        console.log('📅 ' + new Date().toLocaleString('pt-BR'));
        console.log('═'.repeat(60));

        // Executa o script de teste em processo filho
        exec(`node ${REGRESSION_SCRIPT}`, (error, stdout, stderr) => {
            const duration = ((Date.now() - startTime) / 1000).toFixed(1);

            if (error) {
                console.error(`❌ [CRON] FALHA NA REGRESSÃO (${duration}s)`);
                console.error(`Status: ${error.code}`);
                console.error(stderr);
                // Aqui poderia enviar um alerta (email/slack)
            } else {
                console.log(`✅ [CRON] SUCESSO NA REGRESSÃO (${duration}s)`);
                console.log(stdout); // Loga o resumo dos testes
            }

            isRunning = false;
        });

    }, {
        scheduled: true,
        timezone: 'America/Sao_Paulo'
    });

    console.log('✅ [CRON] Agendado: testes de regressão à meia-noite (America/Sao_Paulo)');
}

export default startRegressionCron;
