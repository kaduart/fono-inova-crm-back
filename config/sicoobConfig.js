import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
import https from 'https';
dotenv.config();

// HTTPS Agent usando PEM
const httpsAgent = new https.Agent({
    cert: fs.readFileSync(process.env.SICOOB_CERT_PATH),
    key: fs.readFileSync(process.env.SICOOB_KEY_PATH),
    rejectUnauthorized: true
});

// Axios para chamadas à API PIX
export const sicoobApi = axios.create({
    baseURL: process.env.SICOOB_API_BASE_URL,
    httpsAgent
});

// Configuração do app
export const sicoobConfig = {
    clientId: process.env.SICOOB_CLIENT_ID,
    pixKey: process.env.SICOOB_PIX_KEY,
    authUrl: process.env.SICOOB_AUTH_URL
};
