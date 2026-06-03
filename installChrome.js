import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

if (process.env.PUPPETEER_SKIP_DOWNLOAD === 'true') {
  console.log('[installChrome] PUPPETEER_SKIP_DOWNLOAD=true — Chrome ignorado.');
  process.exit(0);
}

// .puppeteerrc.cjs define cacheDirectory = <project>/.cache/puppeteer
// npx puppeteer browsers install lê esse arquivo automaticamente
const projectCache = path.join(process.cwd(), '.cache', 'puppeteer', 'chrome');

const FORCE_UPDATE = process.env.FORCE_CHROME_UPDATE === 'true';

if (!FORCE_UPDATE && fs.existsSync(projectCache)) {
  const versions = fs.readdirSync(projectCache).filter(v => v.startsWith('linux-'));
  if (versions.length > 0) {
    const candidate = path.join(projectCache, versions[0], 'chrome-linux64', 'chrome');
    if (fs.existsSync(candidate)) {
      console.log('[installChrome] ✅ Chrome já instalado:', candidate);
      process.exit(0);
    }
  }
}

if (FORCE_UPDATE && fs.existsSync(projectCache)) {
  console.log('[installChrome] 🔄 FORCE_CHROME_UPDATE=true — removendo Chrome antigo...');
  fs.rmSync(projectCache, { recursive: true, force: true });
}

// Detecta a versão exata que o puppeteer-core local espera
function getExpectedChromeVersion() {
  try {
    const pkgPath = path.join(process.cwd(), 'node_modules', 'puppeteer-core', 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const version = pkg.puppeteer?.chrome || pkg.puppeteer?.chromium;
      if (version) {
        console.log(`[installChrome] 🔍 puppeteer-core espera Chrome: ${version}`);
        return version;
      }
    }
  } catch (e) {
    console.warn('[installChrome] ⚠️ Não foi possível ler versão do puppeteer-core:', e.message);
  }
  return null;
}

const expectedVersion = getExpectedChromeVersion();
const installCmd = expectedVersion
  ? `npx @puppeteer/browsers install chrome@${expectedVersion}`
  : 'npx @puppeteer/browsers install chrome@stable';

console.log(`[installChrome] Instalando Chrome: ${installCmd}`);
try {
  execSync(installCmd, { stdio: 'inherit' });
  console.log('[installChrome] ✅ Chrome instalado com sucesso.');
} catch (err) {
  console.error('[installChrome] ❌ Falha na instalação:', err.message);
  process.exit(1);
}
