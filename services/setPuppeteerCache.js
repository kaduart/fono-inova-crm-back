import path from 'path';

// ⚠️ ESSE ARQUIVO DEVE SER IMPORTADO ANTES DE 'puppeteer' EM QUALQUER LUGAR
// O Puppeteer lê PUPPETEER_CACHE_DIR no momento do require/import.
const projectCache = path.join(process.cwd(), '.cache', 'puppeteer');
process.env.PUPPETEER_CACHE_DIR = projectCache; // FORÇA, sem fallback
