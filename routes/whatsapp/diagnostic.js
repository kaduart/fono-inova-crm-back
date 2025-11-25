// routes/whatsapp/diagnostic.js
import express from 'express';
import axios from 'axios';

// ⚠️ Ajusta esse import conforme o nome real do model:
// se seu arquivo é "models/Leads.js", use esse:
import Lead from '../../models/Leads.js';
// se for "Lead.js", troque para:
// import Lead from '../../models/Lead.js';

import { auth } from '../../middleware/auth.js';
import { normalizePhoneForCompare } from '../../utils/phone.js';

const router = express.Router();

/**
 * @typedef {Object} WhatsAppContact
 * @property {string} wa_id
 * @property {{ name?: string }} [profile]
 */

/**
 * @typedef {Object} DiagnosticResult
 * @property {number} mongoLeads
 * @property {number} whatsappContacts
 * @property {{ phone: string, name: string, source: 'whatsapp_api' }[]} missingInMongo
 * @property {string[]} missingInWhatsApp
 * @property {number} historicLeads
 * @property {number} realLeads
 */

/**
 * 🔍 Diagnóstico de Sincronização
 * GET /api/whatsapp/diagnostic/sync
 */
router.get('/sync', auth, async (req, res) => {
  try {
    console.log('🔍 [Diagnostic] Iniciando análise de sincronização...');

    // 1️⃣ Busca todos os leads do MongoDB
    const mongoLeads = await Lead.find().select('phone name tags').lean();
    console.log(`📊 Leads no MongoDB: ${mongoLeads.length}`);

    // Separa leads históricos dos reais
    const historicLeads = mongoLeads.filter((l) =>
      (l.tags && l.tags.includes('importado')) ||
      (l.phone && (
        l.phone.startsWith('hist_') ||
        l.phone.includes('hist')
      ))
    );

    const realLeads = mongoLeads.filter((l) => !historicLeads.includes(l));

    console.log(`📚 Leads históricos: ${historicLeads.length}`);
    console.log(`✅ Leads reais: ${realLeads.length}`);

    // 2️⃣ Busca contatos da API do WhatsApp
    const whatsappApiUrl =
      process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v17.0';
    const phoneNumberId = process.env.META_WABA_PHONE_ID;
    const accessToken = process.env.WHATSAPP_VERIFY_TOKEN;

    if (!phoneNumberId || !accessToken) {
      throw new Error('Credenciais do WhatsApp não configuradas');
    }

    /** @type {WhatsAppContact[]} */
    let whatsappContacts = [];

    try {
      // Tenta buscar contatos via Graph API
      const response = await axios.get(
        `${whatsappApiUrl}/${phoneNumberId}/contacts`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 10000,
        }
      );

      whatsappContacts = response.data.data || [];
      console.log(
        `📱 Contatos na API WhatsApp: ${whatsappContacts.length}`
      );
    } catch (apiError) {
      console.warn(
        '⚠️ Não foi possível buscar contatos da API:',
        apiError.message
      );
      // Continua com array vazio se a API não suportar listagem de contatos
    }


    const mongoPhones = new Set(
      realLeads
        .map((l) => normalizePhoneForCompare(l.phone || l.contact?.phone))
        .filter((p) => p && p.length >= 10) // Só phones válidos
    );

    const whatsappPhones = new Set(
      whatsappContacts.map((c) => normalizePhoneForCompare(c.wa_id))
    );

    // 4️⃣ Identifica divergências
    const missingInMongo = whatsappContacts
      .filter((c) => !mongoPhones.has(normalizePhoneForCompare(c.wa_i || l.contact?.phone)))
      .map((c) => ({
        phone: c.wa_id,
        name: (c.profile && c.profile.name) || 'Sem nome',
        source: 'whatsapp_api',
      }));

    const missingInWhatsApp = realLeads
      .filter((l) => {
        const normalized = normalizePhoneForCompare(l.phone);
        return normalized && normalized.length >= 10 && !whatsappPhones.has(normalized);
      })
      .map((l) => l.phone);

    /** @type {DiagnosticResult} */
    const result = {
      mongoLeads: mongoLeads.length,
      whatsappContacts: whatsappContacts.length,
      missingInMongo,
      missingInWhatsApp,
      historicLeads: historicLeads.length,
      realLeads: realLeads.length,
    };

    console.log(`🔍 Análise concluída:
      - Leads no MongoDB: ${result.mongoLeads}
      - Leads reais: ${result.realLeads}
      - Leads históricos: ${result.historicLeads}
      - Contatos no WhatsApp: ${result.whatsappContacts}
      - Faltando no MongoDB: ${result.missingInMongo.length}
      - Faltando no WhatsApp: ${result.missingInWhatsApp.length}
    `);

    res.json({
      success: true,
      data: result,
      recommendations: generateRecommendations(result),
    });
  } catch (error) {
    console.error('❌ [Diagnostic] Erro:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao executar diagnóstico',
      error: error.message,
    });
  }
});

/**
 * 📋 Gera recomendações baseadas no diagnóstico
 * @param {DiagnosticResult} result
 * @returns {string[]}
 */
function generateRecommendations(result) {
  const recommendations = [];

  if (result.missingInMongo.length > 0) {
    recommendations.push(
      `⚠️ Existem ${result.missingInMongo.length} contatos no WhatsApp que não estão no banco. ` +
        `Execute POST /api/whatsapp/diagnostic/sync-missing para importá-los.`
    );
  }

  if (result.missingInWhatsApp.length > 0) {
    recommendations.push(
      `📱 Existem ${result.missingInWhatsApp.length} leads no banco sem conversa no WhatsApp. ` +
        `Isso é normal para leads importados ou que ainda não interagiram.`
    );
  }

  if (result.historicLeads > result.realLeads * 0.5) {
    recommendations.push(
      `📚 Você tem muitos leads históricos (${result.historicLeads}). ` +
        `Considere arquivá-los em uma coleção separada para melhorar performance.`
    );
  }

  if (
    result.missingInMongo.length === 0 &&
    result.missingInWhatsApp.length === 0
  ) {
    recommendations.push('✅ Sincronização perfeita! Todos os contatos estão alinhados.');
  }

  return recommendations;
}

/**
 * 🔄 Importa contatos faltantes do WhatsApp para o MongoDB
 * POST /api/whatsapp/diagnostic/sync-missing
 */
router.post('/sync-missing', auth, async (req, res) => {
  try {
    console.log('🔄 [Diagnostic] Iniciando importação de contatos faltantes...');

    // Reutiliza lógica do GET /sync chamando a própria API
    const diagnosticResponse = await axios.get(
      `${req.protocol}://${req.get('host')}/api/whatsapp/diagnostic/sync`,
      { headers: { Authorization: req.headers.authorization } }
    );

    const missing = diagnosticResponse.data.data.missingInMongo || [];

    if (!missing.length) {
      return res.json({
        success: true,
        message: 'Nenhum contato novo para importar',
        imported: 0,
      });
    }

    const now = new Date();

    const newLeads = await Lead.insertMany(
      missing.map((c) => ({
        name: c.name,
        phone: c.phone,
        tags: ['whatsapp_sync', 'auto_imported'],
        createdAt: now,
        updatedAt: now,
      })),
      { ordered: false } // Continua mesmo se houver duplicatas
    );

    console.log(`✅ ${newLeads.length} novos leads importados`);

    res.json({
      success: true,
      message: `${newLeads.length} contatos importados com sucesso`,
      imported: newLeads.length,
      contacts: newLeads,
    });
  } catch (error) {
    console.error('❌ [Diagnostic] Erro ao importar:', error);
    res.status(500).json({
      success: false,
      message: 'Erro ao importar contatos',
      error: error.message,
    });
  }
});

export default router;
