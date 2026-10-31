// Loader ESM de teste: redireciona APENAS os serviços de fronteira (HTTP externo e
// atribuição) para stubs. DB (mongod real), models e o cron continuam REAIS.
// Uso: node --import ./tests/adsConversion.cron.boundaries.mjs tests/adsConversion.integration.mjs
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve as r } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const stub = (f) => pathToFileURL(r(here, '_stubs', f)).href;
const BOUNDARIES = ['metaConversionsService.js', 'tiktokConversionsService.js', 'googleAdsConversionsService.js', 'leadAttributionService.js'];
export async function resolve(specifier, context, next) {
  const hit = BOUNDARIES.find((f) => specifier.endsWith('/services/' + f) || specifier.endsWith(f));
  if (hit) return { url: stub(hit), shortCircuit: true };
  return next(specifier, context);
}
