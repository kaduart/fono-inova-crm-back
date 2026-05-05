import { execSync } from 'child_process';

if (process.env.PUPPETEER_SKIP_DOWNLOAD !== 'true') {
  console.log('[installChrome] Instalando Chrome para Puppeteer...');
  execSync('npx puppeteer browsers install chrome', { stdio: 'inherit' });
} else {
  console.log('[installChrome] PUPPETEER_SKIP_DOWNLOAD=true — Chrome ignorado.');
}
