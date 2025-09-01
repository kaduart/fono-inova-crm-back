import dotenv from 'dotenv';
import express from 'express';
import { GoogleAdsApi } from 'google-ads-api';
dotenv.config();

const app = express();
const redirectUri = 'http://localhost:5000/oauth2callback';

app.get('/auth-url', (req, res) => {
    const client = new GoogleAdsApi({
        client_id: process.env.GOOGLE_ADS_CLIENT_ID,
        client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
        developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    });

    const url = `https://accounts.google.com/o/oauth2/v2/auth?` +
        `client_id=${process.env.GOOGLE_ADS_CLIENT_ID}` +
        `&redirect_uri=${encodeURIComponent(redirectUri)}` +
        `&response_type=code` +
        `&scope=https://www.googleapis.com/auth/adwords` +
        `&access_type=offline`;

    res.send(`<a href="${url}" target="_blank">Login Google Ads</a>`);
});

app.get('/oauth2callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.send('Code não recebido');

    const client = new GoogleAdsApi({
        client_id: process.env.GOOGLE_ADS_CLIENT_ID,
        client_secret: process.env.GOOGLE_ADS_CLIENT_SECRET,
        developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    });

    try {
        const { refresh_token } = await client.getRefreshToken({
            code,
            redirect_uri: redirectUri,
        });
        res.send(`Refresh Token: ${refresh_token}`);
    } catch (err) {
        console.error(err);
        res.send('Erro ao trocar code pelo refresh token');
    }
});

app.listen(5000, () => console.log('Servidor rodando na porta 5000'));
