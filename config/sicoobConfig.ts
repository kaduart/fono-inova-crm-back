import axios from 'axios';
import fs from 'fs';
import https from 'https';

export const sicoobApi = axios.create({
    baseURL: process.env.SICOOB_API_BASE_URL, // sandbox ou prod
    httpsAgent: new https.Agent({
        cert: fs.readFileSync(process.env.SICOOB_CERT_PATH),
        key: fs.readFileSync(process.env.SICOOB_KEY_PATH),
        ca: fs.readFileSync(process.env.SICOOB_CA_PATH),
        rejectUnauthorized: true
    })
});

export const sicoobConfig = {
    clientId: process.env.SICOOB_CLIENT_ID,
    pixKey: process.env.SICOOB_PIX_KEY,
    authUrl: process.env.SICOOB_AUTH_URL,
};
