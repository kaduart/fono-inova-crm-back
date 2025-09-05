import express from 'express';
import axios from 'axios';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
dotenv.config();

const app = express();
app.use(bodyParser.json());

const PORT = process.env.PORT || 5000;
const BASE_URL = 'https://api-h.sicoob.com.br'; // ambiente homologação

// 1️⃣ Gerar token OAuth2
const getToken = async () => {
  const params = new URLSearchParams();
  params.append('grant_type', 'client_credentials');
  params.append('client_id', process.env.SICOOB_CLIENT_ID);
  params.append('client_secret', process.env.SICOOB_CLIENT_SECRET);
  params.append('scope', 'cob.pix.read cob.pix.write');

  const res = await axios.post(`${BASE_URL}/token`, params.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  return res.data.access_token;
};

// 2️⃣ Criar cobrança Pix
export const createPix = async (txid, valor, chave, solicitacaoPagador) => {
  const token = await getToken();
  const payload = { txid, valor, chave, solicitacaoPagador };

  const res = await axios.post(`${BASE_URL}/cob/v2/${txid}`, payload, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.data;
};

// 3️⃣ Consultar cobrança Pix
export const getPixStatus = async (txid) => {
  const token = await getToken();
  const res = await axios.get(`${BASE_URL}/cob/v2/${txid}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  return res.data;
};

// 4️⃣ Webhook para receber notificações Pix
app.post('/webhook-notificacao', (req, res) => {
  console.log('📩 Notificação recebida:', req.body);
  res.sendStatus(200);
});

// 5️⃣ Teste rápido
app.get('/test', async (req, res) => {
  try {
    const txid = 'TESTE123';
    const pix = await createPix(txid, '100.00', '+5511999999999', 'Pagamento teste');
    const status = await getPixStatus(txid);
    res.json({ pix, status });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).send(err.response?.data || err.message);
  }
});

app.listen(PORT, () => console.log(`🚀 Sicoob Homologação rodando na porta ${PORT}`));
