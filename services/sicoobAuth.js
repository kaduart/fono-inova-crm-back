import axios from 'axios';
import fs from 'fs';
import https from 'https';
import dotenv from 'dotenv';

dotenv.config();

const httpsAgent = new https.Agent({
  pfx: fs.readFileSync(process.env.SICOOB_PFX_PATH),
  passphrase: process.env.SICOOB_PFX_PASSWORD,
  rejectUnauthorized: true
});

const getSicoobAccessToken = async () => {
  try {
    const scopes = [
      'cob.write',
      'cob.read',
      'cobv.write',
      'cobv.read',
      'lotecobv.write',
      'lotecobv.read',
      'pix.write',
      'pix.read',
      'webhook.read',
      'webhook.write',
      'payloadlocation.write',
      'payloadlocation.read'
    ].join(' ');

    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', process.env.SICOOB_CLIENT_ID);
    params.append('scope', scopes);

    const response = await axios.post(
      process.env.SICOOB_AUTH_URL,
      params.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        httpsAgent // ⚠️ usa pfx + senha aqui
      }
    );

    return response.data.access_token;
  } catch (error) {
    console.error('❌ Erro ao obter access token:', error.response?.data || error.message);
    throw new Error('Falha na autenticação com o Sicoob');
  }
};

export default getSicoobAccessToken;
