// crons/siteTest.cron.js
// Cron job para testar mensagens do site - roda todo dia às 23h
// Gera relatório de qualidade das respostas da Amanda para leads do site

import cron from 'node-cron';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';

const execAsync = promisify(exec);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

let isRunning = false;

/**
 * Inicializa o cron de teste do site
 * Deve ser chamado no startup do servidor
 */
export function initSiteTestCron() {
  console.log('🌐 Inicializando Site Test Cron...');

  // Roda todo dia às 23:00
  // Formato: minuto hora dia-mês mês dia-semana
  cron.schedule('0 23 * * *', async () => {
    if (isRunning) {
      console.log('⏭️ Site Test já está rodando, pulando...');
      return;
    }

    isRunning = true;
    console.log(`🌐 [${new Date().toISOString()}] Executando teste do site...`);

    try {
      const scriptPath = path.join(__dirname, '../tests-amanda-ouro/scripts/SCRIPT-testar-site-completo.js');
      
      // Executa o script de teste
      const { stdout, stderr } = await execAsync(`node ${scriptPath}`, {
        timeout: 600000, // 10 minutos timeout
        env: { ...process.env, NODE_ENV: 'production' }
      });

      console.log('✅ Site Test concluído');
      
      // Log do resultado (sucesso)
      if (stdout) {
        const lines = stdout.split('\n');
        const summaryLines = lines.filter(l => 
          l.includes('mensagens testadas') || 
          l.includes('páginas cobertas') ||
          l.includes('erros') ||
          l.includes('Relatório salvo')
        );
        summaryLines.forEach(line => console.log(`📊 ${line.trim()}`));
        
        // Extrai o caminho do relatório gerado
        const reportLine = lines.find(l => l.includes('Relatório salvo'));
        if (reportLine) {
          console.log(`📄 ${reportLine.trim()}`);
        }
      }

      // Envia notificação se houver erros
      if (stderr && stderr.includes('erro')) {
        console.error('⚠️ Site Test com erros:', stderr);
        // TODO: Enviar alerta para admin
      }

    } catch (error) {
      console.error('❌ Erro no Site Test Cron:', error.message);
      // TODO: Enviar alerta para admin
    } finally {
      isRunning = false;
    }
  }, {
    timezone: 'America/Sao_Paulo',
    scheduled: true
  });

  console.log('✅ Site Test Cron inicializado (todo dia às 23h)');
}

/**
 * Executa o teste do site manualmente (para teste/debug)
 */
export async function runSiteTestManual() {
  console.log('🌐 Executando Site Test manual...');
  
  const scriptPath = path.join(__dirname, '../tests-amanda-ouro/scripts/SCRIPT-testar-site-completo.js');
  
  try {
    const { stdout } = await execAsync(`node ${scriptPath}`, {
      timeout: 600000,
      env: { ...process.env, NODE_ENV: 'production' }
    });
    
    console.log(stdout);
    return { success: true, output: stdout };
  } catch (error) {
    console.error('❌ Erro:', error.message);
    return { success: false, error: error.message };
  }
}

export default { initSiteTestCron, runSiteTestManual };
