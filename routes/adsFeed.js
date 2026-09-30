// routes/adsFeed.js
// Feed CSV de conversões offline para o Google Ads (Upload programado via HTTPS).
// Google Ads → Metas → Conversões → Uploads → Programações → HTTPS, usuário/senha = ADS_FEED_USER/ADS_FEED_PASS.
// Dispensa developer token/OAuth. Sem dado clínico: só gclid, horário e valor.
import express from 'express';
import crypto from 'crypto';
import AdConversion from '../models/AdConversion.js';

const router = express.Router();

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function basicAuth(req, res, next) {
  const user = process.env.ADS_FEED_USER; const pass = process.env.ADS_FEED_PASS;
  if (!user || !pass) return res.status(404).end();
  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const [u, ...rest] = Buffer.from(encoded, 'base64').toString().split(':');
    if (safeEqual(u, user) && safeEqual(rest.join(':'), pass)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="ads-feed"');
  return res.status(401).end();
}

// "yyyy-MM-dd HH:mm:ss" em America/Sao_Paulo (UTC-3, sem horário de verão)
const fmt = (d) => new Date(new Date(d).getTime() - 3 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);
const csvCell = (v) => /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);

router.get('/google-offline.csv', basicAuth, async (req, res) => {
  try {
    const name = process.env.GOOGLE_ADS_CONVERSION_NAME || 'Avaliação agendada';
    const rows = await AdConversion.find({
      gclid: { $nin: [null, ''] },
      eventTime: { $gte: new Date(Date.now() - 60 * 864e5) }, // Google aceita até 90 dias após o clique
    }).select('appointment gclid eventTime value').sort({ eventTime: 1 }).lean();

    // Formato padrão = Central de Dados (Data Manager): cabeçalho simples, fuso no próprio horário.
    // ?format=legacy = modelo antigo de upload programado (linha Parameters:TimeZone + nomes em inglês).
    const legacy = req.query.format === 'legacy';
    const lines = legacy
      ? [
          'Parameters:TimeZone=America/Sao_Paulo',
          'Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency',
          ...rows.map((r) => [r.gclid, name, fmt(r.eventTime), Number(r.value || 0).toFixed(2), 'BRL'].map(csvCell).join(',')),
        ]
      : [
          'gclid,conversion_time,transaction_id,event_source,conversion_value,currency',
          ...rows.map((r) => [r.gclid, `${fmt(r.eventTime)}-03:00`, `appt_${r.appointment}`, 'OTHER', Number(r.value || 0).toFixed(2), 'BRL'].map(csvCell).join(',')),
        ];
    console.log(`[AdsFeed] Google CSV servido: ${rows.length} conversões`);
    res.set('Content-Type', 'text/csv; charset=utf-8').set('Cache-Control', 'no-store').send(lines.join('\n') + '\n');
  } catch (err) {
    console.error('[AdsFeed] ❌', err.message);
    res.status(500).end();
  }
});

export default router;
