/**
 * Bootstrap para testes - Carrega dotenv antes de tudo
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Carrega variáveis de ambiente PRIMEIRO
dotenv.config({ path: join(__dirname, '../../.env') });

// Agora importa os testes
await import('./flows.test.js');
