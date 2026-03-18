/**
 * 📊 ANÁLISE SEMANAL - LEADS E GMB
 * Acesso direto ao banco para dados assertivos
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

// Configuração de datas (últimos 7 dias)
const hoje = new Date();
const inicioSemana = new Date(hoje);
inicioSemana.setDate(hoje.getDate() - 7);
inicioSemana.setHours(0, 0, 0, 0);

console.log('📅 Período de análise:');
console.log('   De:', inicioSemana.toLocaleDateString('pt-BR'));
console.log('   Até:', hoje.toLocaleDateString('pt-BR'));
console.log('');

// Schemas simplificados
const leadSchema = new mongoose.Schema({
  name: String,
  contact: { phone: String, email: String },
  origin: String,
  status: String,
  metaTracking: {
    source: String,
    campaign: String,
    specialty: String
  },
  createdAt: Date
}, { collection: 'leads' });

const gmbPostSchema = new mongoose.Schema({
  title: String,
  content: String,
  type: String,
  theme: String,
  status: String,
  publishedAt: Date,
  metrics: {
    views: Number,
    clicks: Number
  },
  createdAt: Date
}, { collection: 'gmbposts' });

const Lead = mongoose.model('Lead', leadSchema);
const GmbPost = mongoose.model('GmbPost', gmbPostSchema);

async function analisar() {
  try {
    console.log('🔌 Conectando ao MongoDB...');
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Conectado!\n');

    // ═══════════════════════════════════════════════════════════════════════
    // 📊 ANÁLISE DE LEADS DA SEMANA
    // ═══════════════════════════════════════════════════════════════════════
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('📊 LEADS - ÚLTIMOS 7 DIAS');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const leadsSemana = await Lead.find({
      createdAt: { $gte: inicioSemana, $lte: hoje }
    }).lean();

    console.log(`Total de leads: ${leadsSemana.length}\n`);

    // Agrupar por origem
    const porOrigem = {};
    leadsSemana.forEach(l => {
      const origem = l.origin || 'Não informado';
      porOrigem[origem] = (porOrigem[origem] || 0) + 1;
    });

    console.log('📍 DISTRIBUIÇÃO POR ORIGEM:');
    Object.entries(porOrigem)
      .sort((a, b) => b[1] - a[1])
      .forEach(([origem, count]) => {
        const pct = ((count / leadsSemana.length) * 100).toFixed(1);
        console.log(`   ${origem}: ${count} leads (${pct}%)`);
      });

    // Análise de metaTracking.source
    console.log('\n📍 POR SOURCE (metaTracking):');
    const porSource = {};
    leadsSemana.forEach(l => {
      const source = l.metaTracking?.source || 'Não rastreado';
      porSource[source] = (porSource[source] || 0) + 1;
    });
    Object.entries(porSource)
      .sort((a, b) => b[1] - a[1])
      .forEach(([source, count]) => {
        const pct = ((count / leadsSemana.length) * 100).toFixed(1);
        console.log(`   ${source}: ${count} leads (${pct}%)`);
      });

    // Google Ads específico
    const googleAds = leadsSemana.filter(l => 
      l.origin?.toLowerCase().includes('google') ||
      l.metaTracking?.source?.toLowerCase().includes('google')
    );
    console.log(`\n🎯 GOOGLE ADS: ${googleAds.length} leads`);

    // Orgânico
    const organico = leadsSemana.filter(l => 
      l.origin?.toLowerCase().includes('organi') ||
      l.origin?.toLowerCase().includes('site') ||
      l.origin?.toLowerCase().includes('whatsapp') ||
      l.metaTracking?.source === 'organic' ||
      l.metaTracking?.source === 'whatsapp'
    );
    console.log(`🌱 ORGÂNICO: ${organico.length} leads`);

    // Meta Ads
    const metaAds = leadsSemana.filter(l => 
      l.origin?.toLowerCase().includes('meta') ||
      l.origin?.toLowerCase().includes('facebook') ||
      l.origin?.toLowerCase().includes('instagram') ||
      l.metaTracking?.source === 'meta_ads'
    );
    console.log(`📱 META ADS: ${metaAds.length} leads`);

    // Por dia
    console.log('\n📅 LEADS POR DIA:');
    const porDia = {};
    leadsSemana.forEach(l => {
      const dia = new Date(l.createdAt).toLocaleDateString('pt-BR');
      porDia[dia] = (porDia[dia] || 0) + 1;
    });
    Object.entries(porDia)
      .sort()
      .forEach(([dia, count]) => {
        console.log(`   ${dia}: ${count} leads`);
      });

    // ═══════════════════════════════════════════════════════════════════════
    // 📊 ANÁLISE GMB DA SEMANA
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('📍 GMB POSTS - ÚLTIMOS 7 DIAS');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const gmbSemana = await GmbPost.find({
      createdAt: { $gte: inicioSemana, $lte: hoje }
    }).sort({ createdAt: -1 }).lean();

    console.log(`Total de posts criados: ${gmbSemana.length}\n`);

    // Por status
    const gmbPorStatus = {};
    gmbSemana.forEach(p => {
      gmbPorStatus[p.status] = (gmbPorStatus[p.status] || 0) + 1;
    });
    console.log('📍 POR STATUS:');
    Object.entries(gmbPorStatus)
      .sort((a, b) => b[1] - a[1])
      .forEach(([status, count]) => {
        console.log(`   ${status}: ${count} posts`);
      });

    // Posts publicados
    const publicados = gmbSemana.filter(p => p.status === 'published');
    console.log(`\n✅ PUBLICADOS: ${publicados.length}`);

    // Posts prontos (não publicados)
    const prontos = gmbSemana.filter(p => p.status === 'ready');
    console.log(`⏳ PRONTOS (aguardando): ${prontos.length}`);

    // Falhas
    const falhas = gmbSemana.filter(p => p.status === 'failed');
    console.log(`❌ FALHAS: ${falhas.length}`);

    // Por tema/especialidade
    console.log('\n📍 POR ESPECIALIDADE:');
    const porTema = {};
    gmbSemana.forEach(p => {
      const tema = p.theme || 'Não definido';
      porTema[tema] = (porTema[tema] || 0) + 1;
    });
    Object.entries(porTema)
      .sort((a, b) => b[1] - a[1])
      .forEach(([tema, count]) => {
        console.log(`   ${tema}: ${count} posts`);
      });

    // Métricas de posts publicados
    if (publicados.length > 0) {
      console.log('\n📊 MÉTRICAS DOS PUBLICADOS:');
      const totalViews = publicados.reduce((sum, p) => sum + (p.metrics?.views || 0), 0);
      const totalClicks = publicados.reduce((sum, p) => sum + (p.metrics?.clicks || 0), 0);
      console.log(`   Views totais: ${totalViews}`);
      console.log(`   Clicks totais: ${totalClicks}`);
      if (totalViews > 0) {
        console.log(`   CTR médio: ${((totalClicks / totalViews) * 100).toFixed(2)}%`);
      }
    }

    // Lista os posts
    console.log('\n📋 POSTS DA SEMANA:');
    gmbSemana.slice(0, 10).forEach((p, i) => {
      const data = new Date(p.createdAt).toLocaleDateString('pt-BR');
      const titulo = p.title?.substring(0, 50) || 'Sem título';
      console.log(`   ${i + 1}. [${data}] ${p.status.toUpperCase()} - ${titulo}...`);
    });

    // ═══════════════════════════════════════════════════════════════════════
    // 📊 COMPARATIVO PAGO vs ORGÂNICO
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('⚖️  ANÁLISE PAGO vs ORGÂNICO');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const totalPago = googleAds.length + metaAds.length;
    const totalOrganico = organico.length;
    const totalOutros = leadsSemana.length - totalPago - totalOrganico;

    console.log(`🎯 TRÁFEGO PAGO: ${totalPago} leads (${((totalPago/leadsSemana.length)*100).toFixed(1)}%)`);
    console.log(`   - Google Ads: ${googleAds.length}`);
    console.log(`   - Meta Ads: ${metaAds.length}`);
    console.log(`\n🌱 ORGÂNICO: ${totalOrganico} leads (${((totalOrganico/leadsSemana.length)*100).toFixed(1)}%)`);
    console.log(`\n❓ OUTROS/NÃO IDENTIFICADO: ${totalOutros} leads (${((totalOutros/leadsSemana.length)*100).toFixed(1)}%)`);

    if (totalOrganico === 0 && totalPago > 0) {
      console.log('\n⚠️  ALERTA: Nenhum lead orgânico identificado na semana!');
      console.log('   Isso sugere que todos os leads estão vindo de anúncios pagos.');
    }

    if (totalPago === 0 && totalOrganico > 0) {
      console.log('\n⚠️  ALERTA: Nenhum lead pago identificado na semana!');
      console.log('   Verifique se os anúncios estão ativos e com tracking correto.');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 📊 LEADS POR STATUS
    // ═══════════════════════════════════════════════════════════════════════
    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('📊 STATUS DOS LEADS DA SEMANA');
    console.log('═══════════════════════════════════════════════════════════════\n');

    const porStatus = {};
    leadsSemana.forEach(l => {
      const status = l.status || 'novo';
      porStatus[status] = (porStatus[status] || 0) + 1;
    });
    Object.entries(porStatus)
      .sort((a, b) => b[1] - a[1])
      .forEach(([status, count]) => {
        const pct = ((count / leadsSemana.length) * 100).toFixed(1);
        console.log(`   ${status}: ${count} (${pct}%)`);
      });

    console.log('\n═══════════════════════════════════════════════════════════════');
    console.log('✅ ANÁLISE CONCLUÍDA');
    console.log('═══════════════════════════════════════════════════════════════');

  } catch (err) {
    console.error('❌ Erro:', err.message);
    console.error(err.stack);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Desconectado do MongoDB');
  }
}

analisar();
