import https from 'https';
import fs from 'fs';

const options = {
  cert: fs.readFileSync('./certs/certificado_publico.pem'),
  key: fs.readFileSync('./certs/certificado_privado.pem'),
  rejectUnauthorized: true
};

const req = https.request({
  hostname: 'www.google.com', // teste de handshake TLS
  port: 443,
  method: 'GET',
  ...options
}, res => {
  console.log('✅ Conexão TLS OK, statusCode:', res.statusCode);
});

req.on('error', err => {
  console.error('❌ Erro na conexão TLS:', err.message);
});

req.end();
