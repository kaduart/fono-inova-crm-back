import { execSync } from 'child_process';
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

// 🔥 CRÍTICO: No Render, /opt/render/.cache NÃO persiste entre build e runtime.
// O Chrome DEVE ficar dentro do diretório do projeto para sobreviver ao deploy.
const projectCache = path.join(process.cwd(), '.cache', 'puppeteer');
process.env.PUPPETEER_CACHE_DIR = projectCache; // FORÇA, sem fallback

if (process.env.PUPPETEER_SKIP_DOWNLOAD === 'true') {
  console.log('[installChrome] PUPPETEER_SKIP_DOWNLOAD=true — Chrome ignorado.');
  process.exit(0);
}

// Descobre qual versão o Puppeteer instalado espera
let expectedPath;
try {
  expectedPath = puppeteer.executablePath();
} catch (err) {
  console.log('[installChrome] Puppeteer ainda sem cache, prosseguindo com instalação...');
  expectedPath = null;
}

if (expectedPath && fs.existsSync(expectedPath)) {
  console.log('[installChrome] ✅ Chrome já instalado:', expectedPath);
  process.exit(0);
}

// Extrai buildId do path esperado
// Ex: /opt/render/.cache/puppeteer/chrome/linux-146.0.7680.31/chrome-linux64/chrome
let buildId = 'stable';
if (expectedPath) {
  const match = expectedPath.match(/chrome\/linux-([\d.]+)\//);
  if (match) {
    buildId = match[1];
  }
}

console.log(`[installChrome] Chrome não encontrado.`);
console.log(`[installChrome] Path esperado: ${expectedPath || 'desconhecido'}`);
console.log(`[installChrome] Tentando instalar versão: ${buildId}`);

try {
  execSync(`npx puppeteer browsers install chrome@${buildId}`, { stdio: 'inherit' });
  console.log('[installChrome] ✅ Instalação concluída.');
} catch (err) {
  console.warn(`[installChrome] ⚠️ Falha ao instalar chrome@${buildId}, tentando stable...`);
  try {
    execSync('npx puppeteer browsers install chrome', { stdio: 'inherit' });
    console.log('[installChrome] ✅ Instalação stable concluída.');
  } catch (err2) {
    console.error('[installChrome] ❌ Falha total na instalação do Chrome:', err2.message);
    process.exit(1);
  }
}
