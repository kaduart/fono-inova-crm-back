import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { PINNED_CHROME_VERSION, chromeBinarySubpath } from './config/chromeVersion.js';

if (process.env.PUPPETEER_SKIP_DOWNLOAD === 'true') {
  console.log('[installChrome] PUPPETEER_SKIP_DOWNLOAD=true — Chrome ignorado.');
  process.exit(0);
}

// NÃO voltar para `chrome@stable`: o canal stable recebe patch a cada poucos
// dias e o worker rebuilda todo dia útil às 07:30 BRT (resume disparado por
// crons/workerScheduler.cron.js), então o build baixava um Chrome diferente sem
// ninguém pedir. Ver config/chromeVersion.js para a versão e o histórico.
const CHROME_VERSION = PINNED_CHROME_VERSION;

const FORCE_UPDATE = process.env.FORCE_CHROME_UPDATE === 'true';

// @puppeteer/browsers instala em <cwd>/chrome/linux-<versao>/chrome-linux64/chrome.
// (.puppeteerrc.cjs só afeta o pacote `puppeteer`, não o CLI @puppeteer/browsers —
// por isso a checagem antiga em .cache/puppeteer nunca batia e rebaixava sempre.)
const installRoot = path.join(process.cwd(), 'chrome');
const candidates = [
  path.join(installRoot, chromeBinarySubpath(CHROME_VERSION)),
  path.join(process.cwd(), '.cache', 'puppeteer', 'chrome', chromeBinarySubpath(CHROME_VERSION)),
];

const existing = candidates.find((p) => fs.existsSync(p));

if (existing && !FORCE_UPDATE) {
  console.log(`[installChrome] ✅ Chrome ${CHROME_VERSION} já presente: ${existing}`);
  process.exit(0);
}

// Remove versões antigas — evita acumular Chrome de builds anteriores no disco
// e garante que resolveChromePath() não pegue um binário divergente do pin.
if (fs.existsSync(installRoot)) {
  for (const dir of fs.readdirSync(installRoot)) {
    if (dir.startsWith('linux-') && dir !== `linux-${CHROME_VERSION}`) {
      console.log(`[installChrome] 🧹 Removendo Chrome divergente: ${dir}`);
      fs.rmSync(path.join(installRoot, dir), { recursive: true, force: true });
    }
  }
}

console.log(`[installChrome] 📌 Instalando Chrome fixado: ${CHROME_VERSION}`);
try {
  execSync(`npx @puppeteer/browsers install chrome@${CHROME_VERSION}`, { stdio: 'inherit' });
  console.log('[installChrome] ✅ Chrome instalado com sucesso.');
} catch (err) {
  console.error('[installChrome] ❌ Falha na instalação:', err.message);
  process.exit(1);
}
