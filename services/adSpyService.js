/**
 * 🔍 Ad Spy Service - Integração com Meta Ad Library API
 * Busca anúncios de concorrentes para análise e adaptação
 */

import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Palavras-chave por especialidade (rotacionar nas buscas)
const KEYWORDS_BY_ESPECIALIDADE = {
  fonoaudiologia: ['fonoaudiologia infantil', 'atraso de fala', 'gagueira criança', 'fono criança'],
  psicologia: ['psicologia infantil', 'comportamento criança', 'autismo criança'],
  terapia_ocupacional: ['terapia ocupacional infantil', 'coordenação motora criança'],
  fisioterapia: ['fisioterapia pediátrica', 'fisio infantil'],
  musicoterapia: ['musicoterapia infantil', 'música terapia criança'],
  geral: ['clínica infantil', 'desenvolvimento infantil', 'criança especialista'],
};

const META_AD_LIBRARY_API = 'https://graph.facebook.com/v19.0/ads_archive';

/**
 * Busca anúncios na Meta Ad Library
 * @param {Object} params - Parâmetros de busca
 * @param {string} params.keyword - Palavra-chave de busca
 * @param {string} params.especialidade - Especialidade médica
 * @param {number} params.limit - Limite de resultados (padrão: 20)
 * @returns {Promise<Array>} Lista de anúncios formatados
 */
export async function searchAds({ keyword, especialidade, limit = 20 }) {
  try {
    const token = process.env.META_AD_LIBRARY_TOKEN;
    
    if (!token) {
      throw new Error('META_AD_LIBRARY_TOKEN não configurado');
    }

    // Se não houver keyword específica, usar keywords da especialidade
    let searchTerms = keyword;
    if (!searchTerms && especialidade && KEYWORDS_BY_ESPECIALIDADE[especialidade]) {
      // Rotacionar keywords da especialidade
      const keywords = KEYWORDS_BY_ESPECIALIDADE[especialidade];
      searchTerms = keywords[Math.floor(Math.random() * keywords.length)];
    }
    
    if (!searchTerms) {
      searchTerms = 'fonoaudiologia infantil';
    }

    const params = {
      access_token: token,
      ad_type: 'ALL',
      ad_reached_countries: 'BR',
      search_terms: searchTerms,
      ad_active_status: 'ACTIVE',
      fields: 'id,ad_creative_bodies,ad_creative_link_captions,ad_creative_link_titles,page_name,page_id,ad_delivery_start_time,ad_snapshot_url,impressions,spend',
      limit: limit
    };

    const url = new URL(META_AD_LIBRARY_API);
    Object.keys(params).forEach(key => url.searchParams.append(key, params[key]));
    
    const response = await fetch(url.toString(), { 
      signal: AbortSignal.timeout(30000)
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    
    const data = await response.json();
    const ads = data.data || [];
    
    // Formatar e enriquecer dados
    return ads.map(ad => {
      const startDate = ad.ad_delivery_start_time ? new Date(ad.ad_delivery_start_time) : null;
      const daysActive = startDate 
        ? Math.floor((Date.now() - startDate.getTime()) / (1000 * 60 * 60 * 24))
        : 0;

      return {
        adId: ad.id,
        pageName: ad.page_name || 'Desconhecido',
        pageId: ad.page_id,
        adText: ad.ad_creative_bodies?.[0] || '',
        adTitle: ad.ad_creative_link_titles?.[0] || '',
        adCaption: ad.ad_creative_link_captions?.[0] || '',
        snapshotUrl: ad.ad_snapshot_url,
        keyword: searchTerms,
        especialidade: especialidade || 'geral',
        daysActive,
        impressions: ad.impressions?.lower_bound || 0,
        spend: ad.spend?.lower_bound || 0,
        deliveryStartTime: ad.ad_delivery_start_time,
        createdAt: new Date().toISOString()
      };
    }).sort((a, b) => b.daysActive - a.daysActive); // Ordenar por mais tempo ativo

  } catch (error) {
    console.error('Erro ao buscar anúncios:', error.message);
    
    // Se for erro de autenticação ou limite, retornar mock para não quebrar
    const status = error.message.match(/HTTP (\d+)/)?.[1];
    if (status === '400' || status === '403' || status === '401') {
      console.warn('Token inválido ou limite atingido, retornando dados mockados');
      return getMockAds(especialidade, keyword);
    }
    
    // Qualquer outro erro também retorna mock para não quebrar a experiência
    console.warn('Erro na API, retornando dados mockados');
    return getMockAds(especialidade, keyword);
  }
}

/**
 * Retorna anúncios mockados para desenvolvimento/testes
 */
function getMockAds(especialidade, keyword) {
  const mockAds = [
    {
      adId: 'mock_1',
      pageName: 'Clínica Infantil Desenvolver',
      pageId: '123456',
      adText: '🗣️ Seu filho ainda não fala frases completas?\n\nNa Clínica Desenvolver, ajudamos crianças a superarem o atraso na fala com uma metodologia lúdica e eficaz.\n\n✅ Atendimento individualizado\n✅ Fono experiente em pediatria\n✅ Ambiente acolhedor\n\n📞 Agende uma avaliação gratuita e descubra como podemos ajudar seu pequeno!\n\nVagas limitadas para este mês.',
      adTitle: 'Avaliação Fonoaudiológica Gratuita',
      adCaption: 'www.clinicadesenvolver.com.br',
      snapshotUrl: 'https://www.facebook.com/ads/library/?id=mock_1',
      keyword: keyword || 'fonoaudiologia infantil',
      especialidade: especialidade || 'fonoaudiologia',
      daysActive: 45,
      impressions: 5000,
      spend: 500,
      createdAt: new Date().toISOString()
    },
    {
      adId: 'mock_2',
      pageName: 'Fono Kids - Fonoaudiologia',
      pageId: '789012',
      adText: '👶🏻 GAGUEIRA NA INFÂNCIA: quando procurar ajuda?\n\nMuitos pais acham que gagueira é fase e vão esperar demais...\n\n⏰ O tempo é fundamental! Quanto mais cedo a intervenção, melhores os resultados.\n\n🎯 Nossa equipe especializada utiliza técnicas modernas para:\n• Fluência verbal\n• Confiança para falar\n• Autonomia na comunicação\n\n💬 "Minha filha parou de ter medo de falar na escola" - Maria, mãe da Júlia (6 anos)\n\n👉 Clique em "Saiba Mais" e conheça nosso trabalho!',
      adTitle: 'Tratamento para Gagueira Infantil',
      adCaption: 'www.fonokids.com.br',
      snapshotUrl: 'https://www.facebook.com/ads/library/?id=mock_2',
      keyword: keyword || 'gagueira criança',
      especialidade: especialidade || 'fonoaudiologia',
      daysActive: 78,
      impressions: 12000,
      spend: 1200,
      createdAt: new Date().toISOString()
    },
    {
      adId: 'mock_3',
      pageName: 'Psicologia Infantil - Crescer Bem',
      pageId: '345678',
      adText: '🧠 COMPORTAMENTO DESAFIADOR?\n\nSeu filho(a):\n❌ Tem birras intensas e frequentes\n❌ Não obedece limites\n❌ Dificuldade de socialização\n❌ Ansiedade excessiva\n\nVocê não está sozinho! 🫂\n\nNossa psicóloga infantil utiliza abordagem lúdica para ajudar crianças a desenvolverem:\n✓ Autorregulação emocional\n✓ Habilidades sociais\n✓ Comunicação assertiva\n\n🎮 Terapia que parece brincadeira, mas transforma!\n\n📅 Agenda aberta para novos pacientes',
      adTitle: 'Psicologia Infantil - Agende Agora',
      adCaption: 'www.crescerbempsicologia.com',
      snapshotUrl: 'https://www.facebook.com/ads/library/?id=mock_3',
      keyword: keyword || 'psicologia infantil',
      especialidade: especialidade || 'psicologia',
      daysActive: 32,
      impressions: 3500,
      spend: 400,
      createdAt: new Date().toISOString()
    },
    {
      adId: 'mock_4',
      pageName: 'TO Vida - Terapia Ocupacional',
      pageId: '901234',
      adText: '✍️ COORDENAÇÃO MOTORA FINA EM ATRASO?\n\nSeu filho tem dificuldade para:\n• Segurar lápis corretamente\n• Recortar com tesoura\n• Fazer laço no tênis\n• Escrever as letras\n\nIsso pode indicar disfunção na coordenação motora fina!\n\n🎯 A Terapia Ocupacional pode ajudar através de:\n→ Atividades lúdicas e funcionais\n→ Estimulação sensorial adequada\n→ Exercícios específicos para escrita\n\n💡 Resultados visíveis em poucas sessões!\n\n👉 Toque no botão para agendar uma avaliação',
      adTitle: 'Terapia Ocupacional Infantil',
      adCaption: 'www.tovidaterapia.com.br',
      snapshotUrl: 'https://www.facebook.com/ads/library/?id=mock_4',
      keyword: keyword || 'terapia ocupacional infantil',
      especialidade: especialidade || 'terapia_ocupacional',
      daysActive: 92,
      impressions: 8000,
      spend: 900,
      createdAt: new Date().toISOString()
    }
  ];

  return mockAds.sort((a, b) => b.daysActive - a.daysActive);
}

/**
 * Analisa anúncio com IA para identificar por que performa
 * @param {Object} params - Dados do anúncio
 * @param {string} params.adText - Texto do anúncio
 * @param {string} params.pageName - Nome da página
 * @param {string} params.adTitle - Título do anúncio
 * @returns {Promise<Object>} Análise detalhada
 */
export async function analyzeAd({ adText, pageName, adTitle }) {
  try {
    const prompt = `Analise este anúncio de clínica de saúde infantil e explique por que ele pode estar convertendo bem.

Nome da página: ${pageName}
Título: ${adTitle || 'N/A'}
Texto do anúncio:
"""
${adText}
"""

Forneça uma análise estruturada em formato JSON:
{
  "gancho": "Qual o gancho/dor específica que o anúncio apresenta",
  "estrutura": "Como o texto está estruturado (ex: problema-agitação-solução, prova social, etc)",
  "cta": "Qual o call-to-action e como é apresentado",
  "porqueConverte": "Por que este anúncio provavelmente está performando bem (tempo ativo, investimento)",
  "pontosFracos": "O que poderia ser melhorado neste anúncio"
}

Responda APENAS com o JSON, sem texto adicional.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { 
          role: 'system', 
          content: 'Você é um especialista em marketing digital para clínicas de saúde infantil. Analise anúncios identificando elementos de copywriting e persuasão.' 
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 1000
    });

    const response = completion.choices[0].message.content.trim();
    
    // Extrair JSON da resposta
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    
    return parseAnalysisFallback(response);
  } catch (error) {
    console.error('Erro ao analisar anúncio:', error);
    return {
      gancho: 'Não foi possível analisar',
      estrutura: 'Não foi possível analisar',
      cta: 'Não foi possível analisar',
      porqueConverte: 'Não foi possível analisar',
      pontosFracos: 'Não foi possível analisar'
    };
  }
}

/**
 * Adapta anúncio para a voz da Fono Inova
 * @param {Object} params - Dados para adaptação
 * @param {string} params.adText - Texto original do anúncio
 * @param {string} params.especialidade - Especialidade médica
 * @param {string} params.funil - Estágio do funil (top, middle, bottom)
 * @param {Object} params.analysis - Análise prévia do anúncio (opcional)
 * @returns {Promise<string>} Texto adaptado
 */
export async function adaptAdForClinica({ adText, especialidade, funil, analysis }) {
  try {
    const funilDesc = {
      top: 'conscientização - foco em educar sobre o problema',
      middle: 'consideração - foco em apresentar soluções',
      bottom: 'decisão - foco em converter com urgência'
    };

    const prompt = `Você é um copywriter especializado em clínicas de saúde infantil.

Adapte o seguinte anúncio concorrente para a Clínica Fono Inova, mantendo a estrutura eficaz mas usando nossa voz e abordagem.

VOZ DA FONO INOVA:
- Profissional mas acolhedora
- Foca na individualidade de cada criança
- Evita alarmismo, usa abordagem positiva
- Valoriza a família e o acompanhamento dos pais
- Usa emojis moderadamente
- Inclui CTA claro no final

ANÚNCIO ORIGINAL:
"""
${adText}
"""

${analysis ? `ANÁLISE DO ANÚNCIO (mantenha os pontos fortes):\n- Gancho: ${analysis.gancho}\n- Estrutura: ${analysis.estrutura}\n- CTA: ${analysis.cta}\n` : ''}

ESPECIALIDADE: ${especialidade}
FUNIL: ${funilDesc[funil] || funilDesc.top}

Crie uma versão adaptada que:
1. Mantenha a estrutura eficaz do original
2. Use a voz da Fono Inova
3. Seja adequada para o estágio do funil indicado
4. Tenha entre 100-200 palavras
5. Inclua emojis relevantes

Responda APENAS com o texto adaptado, sem explicações adicionais.`;

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { 
          role: 'system', 
          content: 'Você é um copywriter especializado em clínicas pediátricas. Crie textos persuasivos e éticos para marketing de saúde infantil.' 
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.8,
      max_tokens: 800
    });

    return completion.choices[0].message.content.trim();
  } catch (error) {
    console.error('Erro ao adaptar anúncio:', error);
    throw new Error('Erro ao gerar versão adaptada');
  }
}

/**
 * Fallback para parsing manual caso o JSON falhe
 */
function parseAnalysisFallback(text) {
  const analysis = {
    gancho: '',
    estrutura: '',
    cta: '',
    porqueConverte: '',
    pontosFracos: ''
  };

  const lines = text.split('\n');
  let currentField = null;

  for (const line of lines) {
    const lowerLine = line.toLowerCase();
    
    if (lowerLine.includes('gancho')) {
      currentField = 'gancho';
      analysis.gancho = line.split(':').slice(1).join(':').trim();
    } else if (lowerLine.includes('estrutura')) {
      currentField = 'estrutura';
      analysis.estrutura = line.split(':').slice(1).join(':').trim();
    } else if (lowerLine.includes('cta') || lowerLine.includes('call-to-action')) {
      currentField = 'cta';
      analysis.cta = line.split(':').slice(1).join(':').trim();
    } else if (lowerLine.includes('por que') || lowerLine.includes('converte')) {
      currentField = 'porqueConverte';
      analysis.porqueConverte = line.split(':').slice(1).join(':').trim();
    } else if (lowerLine.includes('pontos fracos') || lowerLine.includes('melhorar')) {
      currentField = 'pontosFracos';
      analysis.pontosFracos = line.split(':').slice(1).join(':').trim();
    } else if (currentField && line.trim() && !line.includes('{') && !line.includes('}')) {
      analysis[currentField] += ' ' + line.trim();
    }
  }

  return analysis;
}

export default {
  searchAds,
  analyzeAd,
  adaptAdForClinica,
  KEYWORDS_BY_ESPECIALIDADE
};
