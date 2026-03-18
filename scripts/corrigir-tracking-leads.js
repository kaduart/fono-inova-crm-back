/**
 * 🔧 SCRIPT DE CORREÇÃO DO TRACKING DE LEADS
 * Captura UTM/gclid no site e salva corretamente no CRM
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

const leadSchema = new mongoose.Schema({
  name: String,
  contact: { phone: String, email: String },
  origin: String,
  status: String,
  metaTracking: {
    source: String,
    campaign: String,
    specialty: String,
    firstMessage: String,
    utmSource: String,
    utmCampaign: String,
    utmMedium: String,
    gclid: String,
    fbclid: String
  },
  createdAt: Date
}, { collection: 'leads' });

const Lead = mongoose.model('Lead', leadSchema);

async function corrigirTracking() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Conectado ao MongoDB\n');

    // Buscar leads "Agenda Direta" dos últimos 30 dias
    const inicio = new Date();
    inicio.setDate(inicio.getDate() - 30);

    const leadsAgendaDireta = await Lead.find({
      origin: 'Agenda Direta',
      createdAt: { $gte: inicio }
    }).lean();

    console.log(`📊 Total de leads "Agenda Direta" (30 dias): ${leadsAgendaDireta.length}\n`);

    // Analisar primeira mensagem para identificar possíveis leads de ads
    let possiveisGoogleAds = 0;
    let possiveisMetaAds = 0;
    let possiveisOrganicos = 0;

    leadsAgendaDireta.forEach(l => {
      const msg = (l.interactions?.[0]?.message || l.notes || '').toLowerCase();
      
      // Padrões que indicam origem
      if (msg.includes('google') || msg.includes('pesquisa') || msg.includes('anúncio google')) {
        possiveisGoogleAds++;
      } else if (msg.includes('facebook') || msg.includes('instagram') || msg.includes('meta')) {
        possiveisMetaAds++;
      } else if (msg.includes('site') || msg.includes('orgânico') || msg.includes('direto')) {
        possiveisOrganicos++;
      }
    });

    console.log('🔍 ANÁLISE DE ORIGEM (baseado em mensagens):');
    console.log(`   Possíveis Google Ads: ${possiveisGoogleAds}`);
    console.log(`   Possíveis Meta Ads: ${possiveisMetaAds}`);
    console.log(`   Possíveis Orgânicos: ${possiveisOrganicos}`);
    console.log(`   Não identificados: ${leadsAgendaDireta.length - possiveisGoogleAds - possiveisMetaAds - possiveisOrganicos}`);

    // Gerar código de implementação
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('📝 CÓDIGO PARA IMPLEMENTAR NO SITE (Frontend)');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const codigoFrontend = `
// ============================================
// 📍 SCRIPT DE TRACKING - ADICIONAR NO SITE
// Colar no <head> ou antes do fechamento </body>
// ============================================

(function() {
  // Função para pegar parâmetros da URL
  function getUrlParam(name) {
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get(name);
  }

  // Capturar UTMs e IDs de tracking
  const trackingData = {
    utmSource: getUrlParam('utm_source'),
    utmMedium: getUrlParam('utm_medium'),
    utmCampaign: getUrlParam('utm_campaign'),
    gclid: getUrlParam('gclid'),        // Google Ads
    fbclid: getUrlParam('fbclid'),      // Meta/Facebook
    timestamp: new Date().toISOString()
  };

  // Salvar no localStorage para persistir durante a navegação
  if (trackingData.utmSource || trackingData.gclid || trackingData.fbclid) {
    localStorage.setItem('leadTracking', JSON.stringify(trackingData));
    console.log('✅ Tracking capturado:', trackingData);
  }

  // Função para detectar origem
  function detectarOrigem() {
    const dados = JSON.parse(localStorage.getItem('leadTracking') || '{}');
    
    if (dados.gclid || dados.utmSource === 'google') {
      return { source: 'google_ads', campaign: dados.utmCampaign || 'Google_Ads' };
    }
    if (dados.fbclid || dados.utmSource === 'facebook' || dados.utmSource === 'meta') {
      return { source: 'meta_ads', campaign: dados.utmCampaign || 'Meta_Ads' };
    }
    if (dados.utmSource === 'gmb' || dados.utmSource === 'google_meu_negocio') {
      return { source: 'gmb', campaign: dados.utmCampaign || 'GMB' };
    }
    if (dados.utmSource === 'email') {
      return { source: 'email', campaign: dados.utmCampaign || 'Email' };
    }
    
    // Se não tem UTM, verificar referrer
    const referrer = document.referrer;
    if (referrer.includes('google.com')) return { source: 'google_organic', campaign: 'SEO' };
    if (referrer.includes('facebook.com')) return { source: 'facebook_organic', campaign: 'Social' };
    if (referrer.includes('instagram.com')) return { source: 'instagram_organic', campaign: 'Social' };
    
    return { source: 'site_direto', campaign: 'Site_Direto' };
  }

  // Adicionar aos formulários antes de enviar
  window.getLeadTracking = detectarOrigem;
  
  // Expor globalmente para uso no formulário
  window.leadTrackingData = trackingData;
})();

// ============================================
// 📍 USO NO FORMULÁRIO DE AGENDAMENTO
// ============================================
// Quando enviar o formulário, inclua:

async function enviarFormulario(dadosForm) {
  const tracking = window.getLeadTracking ? window.getLeadTracking() : { source: 'site', campaign: 'desconhecido' };
  
  const payload = {
    ...dadosForm,
    origin: tracking.source,  // Isso vai corrigir o "Agenda Direta"
    metaTracking: {
      source: tracking.source,
      campaign: tracking.campaign,
      utmSource: window.leadTrackingData?.utmSource,
      utmCampaign: window.leadTrackingData?.utmCampaign,
      utmMedium: window.leadTrackingData?.utmMedium,
      gclid: window.leadTrackingData?.gclid,
      fbclid: window.leadTrackingData?.fbclid
    }
  };
  
  // Enviar para sua API
  const response = await fetch('/api/leads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  
  return response.json();
}
`;

    console.log(codigoFrontend);

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('📝 CONFIGURAÇÃO PARA GOOGLE ADS (URLs com UTM)');
    console.log('═══════════════════════════════════════════════════════════════\n');

    console.log('Adicione estes parâmetros nas URLs finais dos anúncios:');
    console.log('');
    console.log('Campanha REDE PES:');
    console.log('  ?utm_source=google&utm_medium=cpc&utm_campaign=REDE_PES_Fono&utm_content=grupo_1');
    console.log('');
    console.log('Campanha PSICO:');
    console.log('  ?utm_source=google&utm_medium=cpc&utm_campaign=PSICO_Anapolis&utm_content=avaliacao');
    console.log('');
    console.log('Campanha FONO:');
    console.log('  ?utm_source=google&utm_medium=cpc&utm_campaign=FONO_Anapolis&utm_content=fonoaudiologia');
    console.log('');
    console.log('Campanha TESTE LINGUINHA:');
    console.log('  ?utm_source=google&utm_medium=cpc&utm_campaign=TESTE_LINGUINHA&utm_content=freio_lingual');

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('✅ RESUMO DA IMPLEMENTAÇÃO');
    console.log('═══════════════════════════════════════════════════════════════\n');

    console.log('1. Adicione o script JavaScript no site (frontend)');
    console.log('2. Configure as URLs com UTMs no Google Ads');
    console.log('3. Modifique o formulário de agendamento para enviar os dados de tracking');
    console.log('4. Os leads vão parar de chegar como "Agenda Direta" e vão aparecer corretamente');
    console.log('');
    console.log('📊 Resultado esperado:');
    console.log('   - Google Ads: leads identificados corretamente');
    console.log('   - Orgânico: leads do Google natural identificados');
    console.log('   - GMB: leads do Google Meu Negócio separados');
    console.log('   - Relatórios precisos de ROI por canal');

  } catch (err) {
    console.error('❌ Erro:', err.message);
  } finally {
    await mongoose.disconnect();
  }
}

corrigirTracking();
