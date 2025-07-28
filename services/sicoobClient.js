// services/sicoobClient.ts
import axios from 'axios';
import fs from 'fs';
import https from 'https';

const httpsAgent = new https.Agent({
    cert: fs.readFileSync('certs/cert.pem'),
    key: fs.readFileSync('certs/key.pem'),
    ca: fs.readFileSync('certs/icp-brasil-ca.crt'),
    minVersion: 'TLSv1.2',
    ciphers: [
        'ECDHE-ECDSA-AES256-GCM-SHA384',
        'ECDHE-RSA-AES256-GCM-SHA384',
        'ECDHE-ECDSA-CHACHA20-POLY1305',
        'ECDHE-RSA-CHACHA20-POLY1305'
    ].join(':'),
    honorCipherOrder: true
});

export const sicoobApi = axios.create({
    baseURL: process.env.SICOOB_API_URL,
    httpsAgent
});