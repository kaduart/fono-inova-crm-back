// routes/adsFeed.js
// Feed CSV de conversões offline para o Google Ads (Upload programado via HTTPS).
// Google Ads → Metas → Conversões → Uploads → Programações → HTTPS, usuário/senha = ADS_FEED_USER/ADS_FEED_PASS.
// Dispensa developer token/OAuth. Sem dado clínico: só gclid, horário e valor.
import express from 'express';
import crypto from 'crypto';
import AdConversion from '../models/AdConversion.js';
import Appointment from '../models/Appointment.js';

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

// Correção 4 (20/11; padrão ligado desde a aprovação do Kadu e do analista): uma linha cujo
// agendamento já estava cancelado ANTES da primeira entrega no arquivo não sai. A que já saiu
// continua (o Google pode ter importado; desfazer exige ajuste de conversão, fora daqui).
// "Avaliação agendada" mede agendamento ainda válido na 1ª entrega; comparecimento é a ação
// separada "Avaliação realizada". ADS_FEED_SKIP_CANCELED=off volta à regra antiga (cancelado sai).
export function skipCanceledEnabled(env = process.env) {
  return String(env.ADS_FEED_SKIP_CANCELED || '').trim().toLowerCase() !== 'off';
}
export function feedRows(rows, canceledAppointments = new Set(), skipCanceled = false) {
  if (!skipCanceled) return rows;
  return rows.filter((r) => r.googleCsvFirstServedAt || !canceledAppointments.has(String(r.appointment)));
}

router.get('/google-offline.csv', basicAuth, async (req, res) => {
  try {
    const name = process.env.GOOGLE_ADS_CONVERSION_NAME || 'Avaliação agendada';
    let rows = await AdConversion.find({
      gclid: { $nin: [null, ''] },
      eventTime: { $gte: new Date(Date.now() - 60 * 864e5) }, // Google aceita até 90 dias após o clique
    }).select('_id appointment gclid eventTime value googleCsvFirstServedAt').sort({ eventTime: 1 }).lean();
    const skip = skipCanceledEnabled();
    let canceled = new Set();
    if (skip && rows.length) {
      const notServed = rows.filter((r) => !r.googleCsvFirstServedAt).map((r) => r.appointment);
      const found = notServed.length
        ? await Appointment.find({ _id: { $in: notServed }, operationalStatus: 'canceled' }).select('_id').lean()
        : [];
      canceled = new Set(found.map((a) => String(a._id)));
    }
    rows = feedRows(rows, canceled, skip);
    // Marca a 1ª vez que cada linha sai (aditivo; não muda o arquivo).
    const firstServed = rows.filter((r) => !r.googleCsvFirstServedAt).map((r) => r._id);
    if (firstServed.length) {
      await AdConversion.updateMany({ _id: { $in: firstServed }, googleCsvFirstServedAt: null }, { $set: { googleCsvFirstServedAt: new Date() } });
    }

    // Sem conversão real o arquivo ficaria só com cabeçalho e o Google falha (erro 4000: exige ≥1 linha para
    // detectar o esquema). Linha de exemplo com gclid inválido: o Google a descarta; some quando houver conversão real.
    const realCount = rows.length;
    if (!realCount) {
      rows.push({ appointment: 'setup_exemplo', gclid: 'EXEMPLO_CONFIGURACAO_NAO_IMPORTAR', eventTime: new Date(Date.now() - 3600e3), value: 0 });
    }

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
    console.log(`[AdsFeed] Google CSV servido: ${realCount} conversões reais${realCount ? '' : ' (+1 linha de exemplo)'}`);
    res.set('Content-Type', 'text/csv; charset=utf-8').set('Cache-Control', 'no-store').send(lines.join('\n') + '\n');
  } catch (err) {
    console.error('[AdsFeed] ❌', err.message);
    res.status(500).end();
  }
});

export default router;
