// Configuração compartilhada do "espelho de produção" local.
// O espelho é um MongoDB NA MÁQUINA (replica set — o CRM usa transações),
// nunca no Atlas: produção fica intocável e o Cluster0 não estoura o limite de coleções.
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const BACK_DIR = path.resolve(here, '..', '..');
export const PORT = Number(process.env.ESPELHO_PORT || 27018);
export const REPLSET = 'rsespelho';
export const DB_NAME = 'fono_espelho'; // nunca "fono_inova_prod" (bloqueado pelo assertNotProductionDb)
export const DATA_DIR = path.join(BACK_DIR, '.local', 'mongo-espelho');
export const URI = `mongodb://127.0.0.1:${PORT}/${DB_NAME}?replicaSet=${REPLSET}&directConnection=true`;
export const MONGOD_PATH = process.env.MONGOD_PATH
  || path.join(os.homedir(), '.cache', 'mongodb-binaries', 'mongod-x64-win32-6.0.14.exe');

export const isLocalUri = (uri) => /^mongodb:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(uri);
