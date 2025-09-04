import axios from 'axios';
import fs from 'fs';
import https from 'https';
import { sicoobConfig } from '../config/sicoobConfig.js';

export const getSicoobAccessToken = async () => {
  try {
    // Escopos necessários para a aplicação
    const scopes = [
      'pix.read', 'cobv.read', 'lotecobv.write', 'payloadlocation.read',
      'webhook.write', 'cob.read', 'cob.write', 'webhook.read', 'pix.write',
      'lotecobv.read', 'payloadlocation.write', 'cobv.write'
    ].join(' ');

    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', sicoobConfig.clientId);
    params.append('scope', scopes);

    const response = await axios.post(
      sicoobConfig.authUrl,
      params.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        httpsAgent: new https.Agent({
          cert: fs.readFileSync(sicoobConfig.certificatePath),
          key: fs.readFileSync(sicoobConfig.keyPath),
          ca: fs.readFileSync(sicoobConfig.caPath),
          rejectUnauthorized: true
        })
      }
    );

    return response.data.access_token;
  } catch (error) {
    console.error('Erro ao obter access token:', error.response?.data || error.message);
    throw new Error('Falha na autenticação com o Sicoob');
  }
};