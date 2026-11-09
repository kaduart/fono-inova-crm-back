// routes/google-auth.js
import express from 'express';

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { sendApiError } from '../errors/buildErrorResponse.js';
import { AppError } from '../errors/AppError.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const router = express.Router();


// 🔹 Use variável de ambiente para redirectUri
const redirectUri = process.env.NODE_ENV === 'production'
    ? 'https://fono-inova-crm-back.onrender.com/api/google-ads/auth/oauth2callback'
    : 'http://localhost:5000/api/google-ads/auth/oauth2callback';

// 09/11/2026 (incidente RSS 93% na API): 'googleapis' custa ~56 MB de heap / ~100 MB
// de RSS no import. Este fluxo OAuth é raro (só para gerar refresh token), então a lib
// e o cliente só são criados na 1ª chamada.
let oauth2ClientPromise = null;

function getOAuth2Client() {
    if (oauth2ClientPromise) return oauth2ClientPromise;
    if (!process.env.GOOGLE_ADS_CLIENT_ID || !process.env.GOOGLE_ADS_CLIENT_SECRET) {
        return Promise.reject(new Error('❌ GOOGLE_ADS_CLIENT_ID ou CLIENT_SECRET não estão definidos!'));
    }
    oauth2ClientPromise = import('googleapis')
        .then(({ google }) => new google.auth.OAuth2(
            process.env.GOOGLE_ADS_CLIENT_ID,
            process.env.GOOGLE_ADS_CLIENT_SECRET,
            redirectUri
        ))
        .catch((err) => {
            oauth2ClientPromise = null;
            throw err;
        });
    return oauth2ClientPromise;
}

// ============================
// 1️⃣ Gerar URL de autorização
// ============================
router.get('/auth-url', async (req, res) => {
    try {
        const oauth2Client = await getOAuth2Client();
        const authUrl = oauth2Client.generateAuthUrl({
            access_type: 'offline', // necessário para refresh token
            prompt: 'consent',      // garante que refresh token seja enviado
            scope: ['https://www.googleapis.com/auth/adwords'],
        });

        res.json({ authUrl });
    } catch (error) {
        console.error('Erro ao gerar auth URL:', error);
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', 'Falha ao gerar URL de autenticação', {
            status: 500,
          }),
          req
        );
    }
});

// ============================
// 2️⃣ Callback do Google
// ============================
router.get('/oauth2callback', async (req, res) => {
    try {
        const { code } = req.query;
        if (!code) return res.status(400).send('Código não fornecido');

        const oauth2Client = await getOAuth2Client();

        // 🔹 Passe explicitamente o redirect_uri
        const { tokens } = await oauth2Client.getToken({
            code,
            redirect_uri: redirectUri
        });

        oauth2Client.setCredentials(tokens);

        const refreshToken = tokens.refresh_token;
        if (refreshToken) {
            console.log('Refresh token recebido:', refreshToken);
        } else {
            console.warn('Nenhum refresh token enviado (provavelmente já existia)');
        }

        res.json({
            success: true,
            tokens,
            message: 'Salve o refresh_token em algum lugar seguro. Futuras chamadas usarão ele.',
        });
    } catch (error) {
        console.error('Erro no callback do Google:', error.response?.data || error);
        sendApiError(
          res,
          new AppError('INTERNAL_ERROR', 'Falha na autenticação Google Ads', {
            status: 500,
          }),
          req
        );
    }
});

// ============================
// 4️⃣ Função para gerar access token com refresh token
// ============================
export const getAccessToken = async (refreshToken) => {
    try {
        const oauth2Client = await getOAuth2Client();
        oauth2Client.setCredentials({ refresh_token: refreshToken });
        const { token } = await oauth2Client.getAccessToken();
        return token; // string com access_token válido
    } catch (error) {
        console.error('Erro ao gerar access token via refresh token:', error);
        throw new Error('Falha ao gerar access token');
    }
};

export default router;
