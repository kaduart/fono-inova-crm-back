/**
 * 🎯 Landing Page Service
 * Gerencia as 20+ landing pages de alta conversão
 */

import LandingPage from '../models/LandingPage.js';

// ═══════════════════════════════════════════════════════════════════════════════
// 📊 DADOS DAS 20 LANDING PAGES RECOMENDADAS
// ═══════════════════════════════════════════════════════════════════════════════

export const LANDING_PAGES_DATA = [
  // ═══════════════════════════════════════════════════════════════════════════
  // 🗣️ FONOAUDIOLOGIA (7 LPs)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    slug: 'crianca-2-anos-nao-fala',
    title: 'Criança de 2 anos não fala?',
    headline: 'Criança de 2 anos não fala?',
    subheadline: 'Saiba quando procurar um fonoaudiólogo em Anápolis',
    category: 'fonoaudiologia',
    keywords: ['criança não fala', '2 anos não fala', 'atraso fala', 'fonoaudiologia Anápolis'],
    sinaisAlerta: [
      { icon: '🔇', text: 'Não fala pelo menos 20 palavras' },
      { icon: '🗣️', text: 'Não junta duas palavras' },
      { icon: '👂', text: 'Não responde quando chamada' },
      { icon: '📱', text: 'Só aponta para o que quer' }
    ],
    content: {
      quandoProcurar: 'Aos 2 anos, a criança deve ter um vocabulário de pelo menos 20 palavras e começar a juntar duas palavras. Se isso não acontece, é hora de procurar ajuda.',
      comoFunciona: 'A avaliação fonoaudiológica dura cerca de 1 hora. Fazemos testes específicos para entender o desenvolvimento da linguagem da sua criança.',
      benefícios: [
        'Diagnóstico precoce do atraso na fala',
        'Plano terapêutico personalizado',
        'Acompanhamento com fonoaudióloga especializada',
        'Ambiente lúdico e acolhedor'
      ]
    },
    cta: {
      text: 'Agendar avaliação gratuita',
      link: 'https://wa.me/5562993377726?text=Olá! Vi a página sobre criança de 2 anos não fala e gostaria de agendar uma avaliação.',
      phone: '62993377726'
    },
    seo: {
      title: 'Criança de 2 anos não fala | Fonoaudiólogo em Anápolis | Fono Inova',
      description: 'Seu filho tem 2 anos e ainda não fala? Saiba quando procurar ajuda e como funciona a avaliação fonoaudiológica na Clínica Fono Inova em Anápolis.',
      ogImage: '/images/og/crianca-2-anos-nao-fala.jpg'
    },
    priority: 10,
    isDefault: true
  },
  {
    slug: 'atraso-na-fala-infantil',
    title: 'Atraso na Fala Infantil',
    headline: 'Atraso na fala infantil: quando se preocupar?',
    subheadline: 'Descubra os sinais de alerta e como podemos ajudar seu filho',
    category: 'fonoaudiologia',
    keywords: ['atraso fala', 'desenvolvimento linguagem', 'criança não fala direito', 'fono Anápolis'],
    sinaisAlerta: [
      { icon: '📅', text: 'Não balbucia aos 12 meses' },
      { icon: '📅', text: 'Nenhuma palavra aos 18 meses' },
      { icon: '📅', text: 'Vocabulário muito limitado' },
      { icon: '📅', text: 'Frases incompletas aos 3 anos' }
    ],
    content: {
      quandoProcurar: 'O atraso na fala pode ser identificado desde cedo. Aos 18 meses, a criança já deve dizer algumas palavras. Aos 3 anos, deve formar frases completas.',
      comoFunciona: 'Realizamos uma avaliação completa do desenvolvimento da linguagem, identificamos as dificuldades e criamos um plano terapêutico individualizado.',
      benefícios: [
        'Identificação precoce de problemas',
        'Terapia focada nas necessidades da criança',
        'Orientação aos pais',
        'Espaço acolhedor e preparado'
      ]
    },
    cta: {
      text: 'Quero avaliar meu filho',
      link: 'https://wa.me/5562993377726?text=Olá! Gostaria de saber mais sobre atraso na fala infantil.',
      phone: '62993377726'
    },
    seo: {
      title: 'Atraso na Fala Infantil | Tratamento em Anápolis | Fono Inova',
      description: 'Seu filho tem atraso na fala? Conheça os sinais de alerta e como a fonoaudiologia pode ajudar no desenvolvimento da linguagem.',
      ogImage: '/images/og/atraso-fala-infantil.jpg'
    },
    priority: 9,
    isDefault: true
  },
  {
    slug: 'troca-letras-crianca',
    title: 'Criança Troca Letras',
    headline: 'Criança troca letras ao falar?',
    subheadline: 'Entenda quando é normal e quando procurar ajuda',
    category: 'fonoaudiologia',
    keywords: ['troca letras', 'troca fonemas', 'criança fala errado', 'distúrbio articulação'],
    sinaisAlerta: [
      { icon: '🔤', text: 'Troca R por L' },
      { icon: '🔤', text: 'Troca F por P' },
      { icon: '🔤', text: 'Dificuldade com S' },
      { icon: '🔤', text: 'Palavras incompreensíveis' }
    ],
    content: {
      quandoProcurar: 'A troca de letras é comum até os 4 anos, mas se persistir além dessa idade ou afetar a comunicação, é importante avaliar.',
      comoFunciona: 'Avaliamos a articulação dos sons e desenvolvemos exercícios específicos para corrigir as trocas de forma lúdica.',
      benefícios: [
        'Correção das trocas fonéticas',
        'Melhora na compreensão',
        'Maior confiança para falar',
        'Prevenção de problemas na escrita'
      ]
    },
    cta: {
      text: 'Agendar avaliação',
      link: 'https://wa.me/5562993377726?text=Olá! Minha criança troca letras e gostaria de uma avaliação.',
      phone: '62993377726'
    },
    seo: {
      title: 'Criança Troca Letras | Fonoaudiologia Anápolis | Fono Inova',
      description: 'Sua criança troca letras ao falar? Descubra quando é normal e como a fonoaudiologia pode ajudar a corrigir as trocas fonéticas.',
      ogImage: '/images/og/troca-letras.jpg'
    },
    priority: 8,
    isDefault: true
  },
  {
    slug: 'crianca-nao-forma-frases',
    title: 'Criança Não Forma Frases',
    headline: 'Criança não forma frases completas?',
    subheadline: 'Aos 3 anos, a criança deve fazer frases. Se não faz, podemos ajudar.',
    category: 'fonoaudiologia',
    keywords: ['não forma frases', 'frases incompletas', 'gramática infantil', 'desenvolvimento linguagem'],
    sinaisAlerta: [
      { icon: '📝', text: 'Fala apenas palavras soltas' },
      { icon: '📝', text: 'Não usa verbos' },
      { icon: '📝', text: 'Frases sem sujeito' },
      { icon: '📝', text: 'Não faz perguntas' }
    ],
    content: {
      quandoProcurar: 'Aos 3 anos, a criança deve formar frases simples. Se ela ainda fala apenas palavras isoladas, é hora de avaliar.',
      comoFunciona: 'Trabalhamos a estruturação da frase, aumentando o vocabulário e ensinando a organização das ideias de forma gradual.',
      benefícios: [
        'Desenvolvimento da sintaxe',
        'Aumento do vocabulário',
        'Melhora na comunicação',
        'Preparação para alfabetização'
      ]
    },
    cta: {
      text: 'Quero ajuda para meu filho',
      link: 'https://wa.me/5562993377726?text=Olá! Minha criança não forma frases e preciso de ajuda.',
      phone: '62993377726'
    },
    seo: {
      title: 'Criança Não Forma Frases | Fonoaudiólogo Anápolis | Fono Inova',
      description: 'Sua criança não forma frases completas? Entenda os motivos e como a fonoaudiologia pode estimular o desenvolvimento da linguagem.',
      ogImage: '/images/og/nao-forma-frases.jpg'
    },
    priority: 7,
    isDefault: true
  },
  {
    slug: 'fala-enrolada-crianca',
    title: 'Fala Enrolada na Criança',
    headline: 'Criança fala enrolado?',
    subheadline: 'Disfluências podem ser tratadas com fonoaudiologia',
    category: 'fonoaudiologia',
    keywords: ['fala enrolada', 'gagueira', 'disfluência', 'tropeça nas palavras'],
    sinaisAlerta: [
      { icon: '🗣️', text: 'Repete sílabas (te-te-te-teto)' },
      { icon: '🗣️', text: 'Prolonga sons (sssssapato)' },
      { icon: '🗣️', text: 'Faz pausas no meio da frase' },
      { icon: '🗣️', text: 'Evita falar em público' }
    ],
    content: {
      quandoProcurar: 'Disfluências ocasionais são normais, mas se forem frequentes ou causarem frustração na criança, procure ajuda.',
      comoFunciona: 'Avaliamos o tipo de disfluência e desenvolvemos estratégias para melhorar a fluência da fala de forma acolhedora.',
      benefícios: [
        'Melhora da fluência',
        'Redução da ansiedade ao falar',
        'Técnicas de respiração',
        'Maior confiança'
      ]
    },
    cta: {
      text: 'Agendar avaliação',
      link: 'https://wa.me/5562993377726?text=Olá! Minha criança fala enrolado e gostaria de ajuda.',
      phone: '62993377726'
    },
    seo: {
      title: 'Fala Enrolada em Criança | Tratamento Anápolis | Fono Inova',
      description: 'Sua criança fala enrolado ou apresenta disfluências? Saiba como a fonoaudiologia pode ajudar a melhorar a fluência da fala.',
      ogImage: '/images/og/fala-enrolada.jpg'
    },
    priority: 6,
    isDefault: true
  },
  {
    slug: 'dificuldade-pronunciar-r',
    title: 'Dificuldade para Pronunciar R',
    headline: 'Criança não consegue falar o R?',
    subheadline: 'A fonoaudiologia pode ajudar a corrigir a pronúncia do R',
    category: 'fonoaudiologia',
    keywords: ['não fala R', 'troca R por L', 'criança fala L', 'distúrbio fonético'],
    sinaisAlerta: [
      { icon: '👅', text: 'Fala "lelo" em vez de "relo"' },
      { icon: '👅', text: 'Fala "lua" em vez de "rua"' },
      { icon: '👅', text: 'Evita palavras com R' },
      { icon: '👅', text: 'Tem mais de 5 anos' }
    ],
    content: {
      quandoProcurar: 'Aos 5 anos, a criança já deve pronunciar o R corretamente. Se ainda troca por L, é hora de avaliar.',
      comoFunciona: 'Trabalhamos a posição correta da língua e praticamos os sons de forma gradual e divertida.',
      benefícios: [
        'Correção da pronúncia',
        'Maior clareza na fala',
        'Mais confiança ao falar',
        'Prevenção de bullying'
      ]
    },
    cta: {
      text: 'Quero corrigir a fala do meu filho',
      link: 'https://wa.me/5562993377726?text=Olá! Minha criança não fala o R direito, pode me ajudar?',
      phone: '62993377726'
    },
    seo: {
      title: 'Criança Não Fala o R | Fonoaudiologia Anápolis | Fono Inova',
      description: 'Sua criança troca o R por L? A fonoaudiologia pode ajudar a corrigir a pronúncia de forma eficaz e divertida.',
      ogImage: '/images/og/dificuldade-r.jpg'
    },
    priority: 5,
    isDefault: true
  },
  {
    slug: 'gagueira-infantil',
    title: 'Gagueira Infantil',
    headline: 'Criança com gagueira?',
    subheadline: 'Tratamento especializado para fluência da fala em Anápolis',
    category: 'fonoaudiologia',
    keywords: ['gagueira', 'gago', 'fluência', 'fala travada', 'balbucio'],
    sinaisAlerta: [
      { icon: '💬', text: 'Repete sons ou sílabas' },
      { icon: '💬', text: 'Bloqueios ao falar' },
      { icon: '💬', text: 'Evita situações de fala' },
      { icon: '💬', text: 'Tensão muscular ao falar' }
    ],
    content: {
      quandoProcurar: 'A gagueira precisa de acompanhamento fonoaudiológico. Quanto antes começar o tratamento, melhores os resultados.',
      comoFunciona: 'Oferecemos terapia especializada para fluência, com técnicas modernas e abordagem acolhedora.',
      benefícios: [
        'Melhora significativa da fluência',
        'Técnicas de controle da fala',
        'Redução da ansiedade',
        'Acompanhamento contínuo'
      ]
    },
    cta: {
      text: 'Iniciar tratamento',
      link: 'https://wa.me/5562993377726?text=Olá! Preciso de ajuda com gagueira infantil.',
      phone: '62993377726'
    },
    seo: {
      title: 'Gagueira Infantil | Tratamento em Anápolis | Fono Inova',
      description: 'Criança com gagueira? Conheça nosso tratamento especializado para fluência da fala em Anápolis.',
      ogImage: '/images/og/gagueira.jpg'
    },
    priority: 8,
    isDefault: true
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 🧩 AUTISMO (5 LPs)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    slug: 'sinais-autismo-bebe',
    title: 'Sinais de Autismo no Bebê',
    headline: 'Sinais de autismo no bebê: o que observar?',
    subheadline: 'Identifique os primeiros sinais e procure ajuda especializada',
    category: 'autismo',
    keywords: ['autismo bebê', 'sinais autismo', 'TEA bebê', 'autismo infantil', 'autismo 1 ano'],
    sinaisAlerta: [
      { icon: '👶', text: 'Não mantém contato visual' },
      { icon: '👶', text: 'Não responde ao nome' },
      { icon: '👶', text: 'Não aponta para objetos' },
      { icon: '👶', text: 'Não faz sons de balbucio' }
    ],
    content: {
      quandoProcurar: 'Sinais de autismo podem aparecer antes dos 2 anos. Se observar comportamentos diferentes, procure uma avaliação especializada.',
      comoFunciona: 'Realizamos avaliação multiprofissional com psicólogo e fonoaudiólogo para diagnóstico precoce do TEA.',
      benefícios: [
        'Diagnóstico precoce',
        'Intervenção especializada',
        'Equipe multiprofissional',
        'Ambiente acolhedor'
      ]
    },
    cta: {
      text: 'Avaliação especializada',
      link: 'https://wa.me/5562993377726?text=Olá! Suspeito de autismo no meu bebê e gostaria de uma avaliação.',
      phone: '62993377726'
    },
    seo: {
      title: 'Sinais de Autismo no Bebê | Avaliação em Anápolis | Fono Inova',
      description: 'Quais são os primeiros sinais de autismo no bebê? Saiba quando procurar ajuda e como funciona a avaliação especializada.',
      ogImage: '/images/og/autismo-bebe.jpg'
    },
    priority: 10,
    isDefault: true
  },
  {
    slug: 'sinais-autismo-2-anos',
    title: 'Sinais de Autismo aos 2 Anos',
    headline: 'Sinais de autismo aos 2 anos',
    subheadline: 'Identifique os sinais de alerta do TEA nessa idade',
    category: 'autismo',
    keywords: ['autismo 2 anos', 'sinais TEA', 'criança autista', 'diagnóstico autismo'],
    sinaisAlerta: [
      { icon: '🔍', text: 'Não fala palavras' },
      { icon: '🔍', text: 'Não brinca de faz de conta' },
      { icon: '🔍', text: 'Evita contato com outras crianças' },
      { icon: '🔍', text: 'Movimentos repetitivos' }
    ],
    content: {
      quandoProcurar: 'Aos 2 anos, sinais como ausência de fala, falta de contato visual e comportamentos repetitivos podem indicar TEA.',
      comoFunciona: 'Fazemos avaliação completa com protocolos validados para diagnóstico de autismo infantil.',
      benefícios: [
        'Avaliação especializada',
        'Diagnóstico preciso',
        'Plano de intervenção',
        'Acompanhamento multiprofissional'
      ]
    },
    cta: {
      text: 'Agendar avaliação TEA',
      link: 'https://wa.me/5562993377726?text=Olá! Gostaria de agendar uma avaliação para autismo.',
      phone: '62993377726'
    },
    seo: {
      title: 'Sinais de Autismo aos 2 Anos | Diagnóstico Anápolis | Fono Inova',
      description: 'Quais são os sinais de autismo aos 2 anos? Conheça os indicadores e como funciona a avaliação para TEA em Anápolis.',
      ogImage: '/images/og/autismo-2-anos.jpg'
    },
    priority: 9,
    isDefault: true
  },
  {
    slug: 'crianca-nao-responde-nome',
    title: 'Criança Não Responde ao Nome',
    headline: 'Criança não responde quando chama?',
    subheadline: 'Esse pode ser um sinal importante de atenção',
    category: 'autismo',
    keywords: ['não responde nome', 'criança distante', 'não olha', 'autismo sinal'],
    sinaisAlerta: [
      { icon: '📢', text: 'Não vira quando chama' },
      { icon: '📢', text: 'Parece não ouvir' },
      { icon: '📢', text: 'Vive no próprio mundo' },
      { icon: '📢', text: 'Não compartilha atenção' }
    ],
    content: {
      quandoProcurar: 'Se sua criança consistentemente não responde ao nome, é importante avaliar a audição e o desenvolvimento social.',
      comoFunciona: 'Investigamos as causas e fazemos encaminhamentos adequados para fonoaudiologia, psicologia ou neuropediatra.',
      benefícios: [
        'Investigação completa',
        'Equipe especializada',
        'Encaminhamento adequado',
        'Acompanhamento integrado'
      ]
    },
    cta: {
      text: 'Quero uma avaliação',
      link: 'https://wa.me/5562993377726?text=Olá! Minha criança não responde ao nome, preciso de ajuda.',
      phone: '62993377726'
    },
    seo: {
      title: 'Criança Não Responde ao Nome | Avaliação Anápolis | Fono Inova',
      description: 'Criança não responde quando chamada? Entenda as possíveis causas e como a avaliação multiprofissional pode ajudar.',
      ogImage: '/images/og/nao-responde-nome.jpg'
    },
    priority: 8,
    isDefault: true
  },
  {
    slug: 'crianca-nao-olha-olhos',
    title: 'Criança Não Olha nos Olhos',
    headline: 'Criança evita contato visual?',
    subheadline: 'A falta de contato visual pode ser um sinal de alerta',
    category: 'autismo',
    keywords: ['não olha olhos', 'evita contato visual', 'criança distante', 'sinal autismo'],
    sinaisAlerta: [
      { icon: '👁️', text: 'Desvia o olhar' },
      { icon: '👁️', text: 'Não segue seu olhar' },
      { icon: '👁️', text: 'Olha para as mãos/objetos' },
      { icon: '👁️', text: 'Parece não ver as pessoas' }
    ],
    content: {
      quandoProcurar: 'A falta de contato visual pode indicar dificuldades no desenvolvimento social. Uma avaliação pode esclarecer.',
      comoFunciona: 'Avaliamos o desenvolvimento global da criança, incluindo aspectos sociais, comunicativos e comportamentais.',
      benefícios: [
        'Avaliação especializada',
        'Diagnóstico diferencial',
        'Plano terapêutico',
        'Intervenção precoce'
      ]
    },
    cta: {
      text: 'Agendar avaliação',
      link: 'https://wa.me/5562993377726?text=Olá! Minha criança não olha nos olhos e gostaria de uma avaliação.',
      phone: '62993377726'
    },
    seo: {
      title: 'Criança Não Olha nos Olhos | Avaliação Anápolis | Fono Inova',
      description: 'Criança evita contato visual? Entenda quando isso é preocupante e como a avaliação pode ajudar.',
      ogImage: '/images/og/nao-olha-olhos.jpg'
    },
    priority: 7,
    isDefault: true
  },
  {
    slug: 'avaliacao-tea-anapolis',
    title: 'Avaliação de Autismo em Anápolis',
    headline: 'Avaliação de Autismo (TEA) em Anápolis',
    subheadline: 'Diagnóstico especializado com equipe multiprofissional',
    category: 'autismo',
    keywords: ['avaliação autismo', 'diagnóstico TEA', 'autismo Anápolis', 'avaliação neuropediátrica'],
    sinaisAlerta: [
      { icon: '✅', text: 'Avaliação completa' },
      { icon: '✅', text: 'Equipe especializada' },
      { icon: '✅', text: 'Laudo válido' },
      { icon: '✅', text: 'Encaminhamento adequado' }
    ],
    content: {
      quandoProcurar: 'Se suspeita de autismo, procure uma avaliação especializada. O diagnóstico precoce é fundamental para o desenvolvimento.',
      comoFunciona: 'Realizamos avaliação completa com psicólogo, fonoaudiólogo e orientação neuropediátrica. O processo é acolhedor e respeitoso.',
      benefícios: [
        'Diagnóstico preciso',
        'Equipe especializada',
        'Acolhimento familiar',
        'Plano de intervenção'
      ]
    },
    cta: {
      text: 'Agendar avaliação TEA',
      link: 'https://wa.me/5562993377726?text=Olá! Gostaria de agendar uma avaliação para autismo/TEA.',
      phone: '62993377726'
    },
    seo: {
      title: 'Avaliação de Autismo em Anápolis | Diagnóstico TEA | Fono Inova',
      description: 'Procure avaliação especializada para autismo em Anápolis. Equipe multiprofissional, laudo válido e acolhimento.',
      ogImage: '/images/og/avaliacao-tea.jpg'
    },
    location: { city: 'Anápolis', state: 'GO' },
    priority: 10,
    isDefault: true
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 🧠 PSICOLOGIA (2 LPs)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    slug: 'crianca-agressiva',
    title: 'Criança Agressiva',
    headline: 'Criança agressiva? Entenda as causas',
    subheadline: 'A psicologia infantil pode ajudar a lidar com agressividade',
    category: 'psicologia',
    keywords: ['criança agressiva', 'criança bate', 'birra', 'raiva infantil', 'psicólogo infantil'],
    sinaisAlerta: [
      { icon: '👊', text: 'Bate em outras crianças' },
      { icon: '👊', text: 'Destrói objetos' },
      { icon: '👊', text: 'Reação de raiva intensa' },
      { icon: '👊', text: 'Não aceita limites' }
    ],
    content: {
      quandoProcurar: 'Agressividade frequente pode indicar dificuldades emocionais. A psicologia infantil ajuda a entender e transformar esse comportamento.',
      comoFunciona: 'Avaliamos as causas da agressividade e trabalhamos estratégias para ajudar a criança a lidar com as emoções.',
      benefícios: [
        'Compreensão do comportamento',
        'Estratégias para pais',
        'Melhora na convivência',
        'Desenvolvimento emocional'
      ]
    },
    cta: {
      text: 'Agendar com psicólogo',
      link: 'https://wa.me/5562993377726?text=Olá! Minha criança é agressiva e preciso de ajuda.',
      phone: '62993377726'
    },
    seo: {
      title: 'Criança Agressiva | Psicólogo Infantil Anápolis | Fono Inova',
      description: 'Criança com comportamento agressivo? A psicologia infantil pode ajudar a entender as causas e transformar o comportamento.',
      ogImage: '/images/og/crianca-agressiva.jpg'
    },
    priority: 8,
    isDefault: true
  },
  {
    slug: 'ansiedade-infantil',
    title: 'Ansiedade Infantil',
    headline: 'Ansiedade na criança: sinais e tratamento',
    subheadline: 'Identifique os sinais de ansiedade e procure ajuda',
    category: 'psicologia',
    keywords: ['ansiedade infantil', 'criança ansiosa', 'medo excessivo', 'transtorno ansiedade'],
    sinaisAlerta: [
      { icon: '😰', text: 'Medo excessivo de se separar' },
      { icon: '😰', text: 'Dificuldade para dormir' },
      { icon: '😰', text: 'Preocupações constantes' },
      { icon: '😰', text: 'Sintomas físicos (dor de barriga)' }
    ],
    content: {
      quandoProcurar: 'Se a ansiedade interfere na rotina da criança (escola, sono, alimentação), é hora de buscar ajuda especializada.',
      comoFunciona: 'Oferecemos terapia infantil com técnicas adequadas para cada idade, ajudando a criança a lidar com as ansiedades.',
      benefícios: [
        'Redução da ansiedade',
        'Melhora do sono',
        'Maior tranquilidade',
        'Desenvolvimento saudável'
      ]
    },
    cta: {
      text: 'Agendar avaliação',
      link: 'https://wa.me/5562993377726?text=Olá! Suspeito de ansiedade na minha criança.',
      phone: '62993377726'
    },
    seo: {
      title: 'Ansiedade Infantil | Psicólogo em Anápolis | Fono Inova',
      description: 'Sua criança apresenta sinais de ansiedade? Conheça o tratamento com psicólogo infantil especializado em Anápolis.',
      ogImage: '/images/og/ansiedade-infantil.jpg'
    },
    priority: 7,
    isDefault: true
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 📚 APRENDIZAGEM (3 LPs)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    slug: 'crianca-nao-aprende-ler',
    title: 'Criança Não Aprende a Ler',
    headline: 'Criança não aprende a ler?',
    subheadline: 'A psicopedagogia pode ajudar no processo de alfabetização',
    category: 'aprendizagem',
    keywords: ['não aprende ler', 'dificuldade leitura', 'dislexia', 'alfabetização', 'psicopedagogia'],
    sinaisAlerta: [
      { icon: '📖', text: 'Troca letras ao ler' },
      { icon: '📖', text: 'Não reconhece palavras' },
      { icon: '📖', text: 'Leitura muito lenta' },
      { icon: '📖', text: 'Evita atividades de leitura' }
    ],
    content: {
      quandoProcurar: 'Se aos 7-8 anos a criança ainda tem dificuldade significativa com a leitura, uma avaliação psicopedagógica é recomendada.',
      comoFunciona: 'Avaliamos as habilidades de leitura e escrita, identificamos dificuldades e desenvolvemos estratégias de ensino individualizadas.',
      benefícios: [
        'Diagnóstico das dificuldades',
        'Estratégias de ensino',
        'Acompanhamento escolar',
        'Maior confiança na leitura'
      ]
    },
    cta: {
      text: 'Agendar avaliação',
      link: 'https://wa.me/5562993377726?text=Olá! Minha criança tem dificuldade para ler.',
      phone: '62993377726'
    },
    seo: {
      title: 'Criança Não Aprende a Ler | Psicopedagogia Anápolis | Fono Inova',
      description: 'Criança com dificuldade para aprender a ler? A psicopedagogia pode identificar as causas e ajudar no processo de alfabetização.',
      ogImage: '/images/og/nao-aprende-ler.jpg'
    },
    priority: 8,
    isDefault: true
  },
  {
    slug: 'sinais-dislexia',
    title: 'Sinais de Dislexia',
    headline: 'Sinais de dislexia na criança',
    subheadline: 'Identifique os sinais e procure ajuda especializada',
    category: 'aprendizagem',
    keywords: ['dislexia', 'troca letras', 'dificuldade leitura', 'dislexia infantil'],
    sinaisAlerta: [
      { icon: '🔤', text: 'Troca letras parecidas (b/d)' },
      { icon: '🔤', text: 'Dificuldade com a ordem das letras' },
      { icon: '🔤', text: 'Leitura lenta e cansativa' },
      { icon: '🔤', text: 'Escrita com muitos erros' }
    ],
    content: {
      quandoProcurar: 'Se a criança troca letras frequentemente, tem leitura lenta e dificuldade de escrita, pode ser dislexia. A avaliação confirma.',
      comoFunciona: 'Realizamos avaliação psicopedagógica completa para diagnóstico de dislexia e elaboramos plano de intervenção.',
      benefícios: [
        'Diagnóstico preciso',
        'Estratégias específicas',
        'Acompanhamento escolar',
        'Melhora na aprendizagem'
      ]
    },
    cta: {
      text: 'Avaliação de dislexia',
      link: 'https://wa.me/5562993377726?text=Olá! Suspeito de dislexia na minha criança.',
      phone: '62993377726'
    },
    seo: {
      title: 'Sinais de Dislexia | Avaliação em Anápolis | Fono Inova',
      description: 'Quais são os sinais de dislexia? Saiba como identificar e como a psicopedagogia pode ajudar crianças com dislexia.',
      ogImage: '/images/og/sinais-dislexia.jpg'
    },
    priority: 7,
    isDefault: true
  },
  {
    slug: 'crianca-troca-letras-escrita',
    title: 'Criança Troca Letras na Escrita',
    headline: 'Criança troca letras na escrita?',
    subheadline: 'Entenda as causas e como ajudar seu filho',
    category: 'aprendizagem',
    keywords: ['troca letras escrita', 'erros escrita', 'disortografia', 'dificuldade escrever'],
    sinaisAlerta: [
      { icon: '✏️', text: 'Escreve "fote" em vez de "fofe"' },
      { icon: '✏️', text: 'Troca ordem das letras' },
      { icon: '✏️', text: 'Omite letras' },
      { icon: '✏️', text: 'Escrita espelhada' }
    ],
    content: {
      quandoProcurar: 'Se a troca de letras persiste além dos 8 anos ou prejudica a compreensão da escrita, é importante avaliar.',
      comoFunciona: 'Avaliamos o processo de escrita e desenvolvemos atividades para melhorar a consciência fonológica e ortográfica.',
      benefícios: [
        'Identificação das dificuldades',
        'Exercícios específicos',
        'Melhora na escrita',
        'Maior autoconfiança'
      ]
    },
    cta: {
      text: 'Agendar avaliação',
      link: 'https://wa.me/5562993377726?text=Olá! Minha criança troca letras na escrita.',
      phone: '62993377726'
    },
    seo: {
      title: 'Criança Troca Letras na Escrita | Psicopedagogia | Fono Inova',
      description: 'Sua criança troca letras ao escrever? Descubra as causas e como a psicopedagogia pode ajudar a melhorar a escrita.',
      ogImage: '/images/og/troca-letras-escrita.jpg'
    },
    priority: 6,
    isDefault: true
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 🤲 TERAPIA OCUPACIONAL (1 LP)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    slug: 'dificuldade-coordenacao-motora',
    title: 'Dificuldade de Coordenação Motora',
    headline: 'Criança com dificuldade de coordenação motora?',
    subheadline: 'A terapia ocupacional pode ajudar no desenvolvimento motor',
    category: 'terapia_ocupacional',
    keywords: ['coordenação motora', 'criança desastrada', 'dificuldade motora', 'terapia ocupacional'],
    sinaisAlerta: [
      { icon: '🏃', text: 'Tropeça frequentemente' },
      { icon: '🏃', text: 'Dificuldade para segurar lápis' },
      { icon: '🏃', text: 'Letra muito feia' },
      { icon: '🏃', text: 'Evita atividades motoras' }
    ],
    content: {
      quandoProcurar: 'Se a criança tem dificuldade com atividades do dia a dia, como se vestir, escrever ou brincar, a terapia ocupacional pode ajudar.',
      comoFunciona: 'Avaliamos as habilidades motoras e desenvolvemos atividades terapêuticas para melhorar a coordenação e independência.',
      benefícios: [
        'Melhora da coordenação',
        'Maior independência',
        'Melhora na escrita',
        'Mais confiança nas atividades'
      ]
    },
    cta: {
      text: 'Agendar avaliação TO',
      link: 'https://wa.me/5562993377726?text=Olá! Minha criança tem dificuldade de coordenação motora.',
      phone: '62993377726'
    },
    seo: {
      title: 'Dificuldade de Coordenação Motora | TO em Anápolis | Fono Inova',
      description: 'Criança desastrada ou com dificuldade motora? A terapia ocupacional pode ajudar no desenvolvimento da coordenação.',
      ogImage: '/images/og/coordenacao-motora.jpg'
    },
    priority: 7,
    isDefault: true
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 📍 GEOGRÁFICAS (3 LPs)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    slug: 'fonoaudiologo-anapolis',
    title: 'Fonoaudiólogo em Anápolis',
    headline: 'Fonoaudiólogo em Anápolis',
    subheadline: 'Atendimento especializado para crianças em Anápolis e região',
    category: 'geografica',
    keywords: ['fonoaudiólogo Anápolis', 'fono Anápolis', 'fonoaudiologia Anápolis', 'atraso fala Anápolis'],
    sinaisAlerta: [
      { icon: '📍', text: 'Atendimento em Anápolis' },
      { icon: '📍', text: 'Fonoaudiólogas especializadas' },
      { icon: '📍', text: 'Ambiente lúdico' },
      { icon: '📍', text: 'Avaliação gratuita' }
    ],
    content: {
      quandoProcurar: 'Se você está em Anápolis ou região e precisa de fonoaudiologia infantil, estamos prontos para atender sua família.',
      comoFunciona: 'Oferecemos avaliação fonoaudiológica completa com profissionais especializadas em desenvolvimento infantil.',
      benefícios: [
        'Localização central em Anápolis',
        'Equipe especializada',
        'Ambiente acolhedor',
        'Avaliação gratuita'
      ]
    },
    cta: {
      text: 'Agendar avaliação gratuita',
      link: 'https://wa.me/5562993377726?text=Olá! Gostaria de agendar uma avaliação fonoaudiológica em Anápolis.',
      phone: '62993377726'
    },
    seo: {
      title: 'Fonoaudiólogo em Anápolis | Avaliação Gratuita | Fono Inova',
      description: 'Procure fonoaudiólogo especializado em Anápolis. Atendimento infantil, avaliação gratuita e ambiente acolhedor.',
      ogImage: '/images/og/fono-anapolis.jpg'
    },
    location: { city: 'Anápolis', state: 'GO' },
    priority: 9,
    isDefault: true
  },
  {
    slug: 'psicologo-infantil-anapolis',
    title: 'Psicólogo Infantil em Anápolis',
    headline: 'Psicólogo Infantil em Anápolis',
    subheadline: 'Atendimento psicológico especializado para crianças e adolescentes',
    category: 'geografica',
    keywords: ['psicólogo infantil Anápolis', 'psicologia infantil Anápolis', 'terapia infantil Anápolis'],
    sinaisAlerta: [
      { icon: '🧠', text: 'Psicóloga especializada' },
      { icon: '🧠', text: 'Atendimento infantil' },
      { icon: '🧠', text: 'Avaliação completa' },
      { icon: '🧠', text: 'Orientação aos pais' }
    ],
    content: {
      quandoProcurar: 'Se você precisa de acompanhamento psicológico para seu filho em Anápolis, nossa equipe está preparada para ajudar.',
      comoFunciona: 'Realizamos avaliação psicológica completa e oferecemos terapia infantil com técnicas adequadas para cada idade.',
      benefícios: [
        'Atendimento especializado',
        'Acolhimento familiar',
        'Técnicas modernas',
        'Acompanhamento contínuo'
      ]
    },
    cta: {
      text: 'Agendar com psicólogo',
      link: 'https://wa.me/5562993377726?text=Olá! Gostaria de agendar com psicólogo infantil em Anápolis.',
      phone: '62993377726'
    },
    seo: {
      title: 'Psicólogo Infantil em Anápolis | Fono Inova',
      description: 'Procure psicólogo infantil especializado em Anápolis. Atendimento para crianças e adolescentes, avaliação completa.',
      ogImage: '/images/og/psicologo-anapolis.jpg'
    },
    location: { city: 'Anápolis', state: 'GO' },
    priority: 8,
    isDefault: true
  },
  {
    slug: 'terapia-ocupacional-anapolis',
    title: 'Terapia Ocupacional em Anápolis',
    headline: 'Terapia Ocupacional em Anápolis',
    subheadline: 'Desenvolvimento motor e autonomia para crianças',
    category: 'geografica',
    keywords: ['terapia ocupacional Anápolis', 'TO Anápolis', 'desenvolvimento motor Anápolis'],
    sinaisAlerta: [
      { icon: '🤲', text: 'Terapeuta ocupacional especializada' },
      { icon: '🤲', text: 'Desenvolvimento motor' },
      { icon: '🤲', text: 'Integração sensorial' },
      { icon: '🤲', text: 'Ambiente preparado' }
    ],
    content: {
      quandoProcurar: 'Se sua criança tem dificuldades motoras ou sensoriais em Anápolis, a terapia ocupacional pode ajudar no desenvolvimento.',
      comoFunciona: 'Avaliamos as necessidades da criança e desenvolvemos intervenções para melhorar a coordenação e autonomia.',
      benefícios: [
        'Atendimento especializado',
        'Ambiente lúdico',
        'Maior autonomia',
        'Acompanhamento familiar'
      ]
    },
    cta: {
      text: 'Agendar avaliação TO',
      link: 'https://wa.me/5562993377726?text=Olá! Gostaria de agendar terapia ocupacional em Anápolis.',
      phone: '62993377726'
    },
    seo: {
      title: 'Terapia Ocupacional em Anápolis | Fono Inova',
      description: 'Terapia Ocupacional em Anápolis. Atendimento especializado para desenvolvimento motor e autonomia infantil.',
      ogImage: '/images/og/to-anapolis.jpg'
    },
    location: { city: 'Anápolis', state: 'GO' },
    priority: 7,
    isDefault: true
  },
  
  // ═══════════════════════════════════════════════════════════════════════════
  // 🧠 AVALIAÇÃO NEUROPSICOLÓGICA (Página Especial)
  // ═══════════════════════════════════════════════════════════════════════════
  {
    slug: 'avaliacao-neuropsicologica-dificuldade-escolar',
    title: 'Avaliação Neuropsicológica - Dificuldade Escolar',
    headline: 'Seu Filho se Esforça, mas as Notas Não Melhoram?',
    subheadline: 'Avaliação neuropsicológica completa no bairro Jundiaí para identificar dislexia, TDAH e outras condições em Anápolis.',
    category: 'aprendizagem',
    keywords: ['avaliação neuropsicológica', 'dificuldade escolar', 'dislexia Anápolis', 'TDAH Anápolis', 'neuropsicólogo infantil'],
    sinaisAlerta: [
      { icon: '📚', text: 'Notas baixas mesmo estudando muito' },
      { icon: '📚', text: 'Dificuldade para ler ou escrever' },
      { icon: '📚', text: 'Esquece o que acabou de aprender' },
      { icon: '📚', text: 'Não consegue se concentrar nas tarefas' },
      { icon: '📚', text: 'Demora muito para fazer lição de casa' },
      { icon: '📚', text: 'Frustração e desânimo com a escola' },
      { icon: '📚', text: 'Troca letras ao escrever (b/d, p/q)' },
      { icon: '📚', text: 'Dificuldade com matemática' }
    ],
    content: {
      quandoProcurar: 'Se seu filho apresenta dificuldades persistentes na escola apesar de se esforçar, uma avaliação neuropsicológica pode identificar condições como dislexia, TDAH ou discalculia.',
      comoFunciona: 'A avaliação neuropsicológica é realizada por uma neuropsicóloga especializada e inclui testes padronizados, entrevistas e relatório completo com plano de intervenção.',
      beneficios: [
        'Diagnóstico preciso das dificuldades',
        'Relatório completo com laudo',
        'Plano de intervenção personalizado',
        'Orientação para pais e escola',
        'Encaminhamento para terapias específicas'
      ]
    },
    cta: {
      text: 'Agendar Avaliação',
      link: 'https://wa.me/5562993377726?text=Oi, vi no site sobre avaliação neuropsicológica e gostaria de agendar.',
      phone: '62993377726'
    },
    seo: {
      title: 'Avaliação Neuropsicológica Infantil em Anápolis | Dificuldade Escolar',
      description: 'Avaliação neuropsicológica completa para identificar dislexia, TDAH e outras condições. Neuropsicóloga especializada em Anápolis - Jundiaí.',
      ogImage: '/images/og/avaliacao-neuropsicologica.jpg'
    },
    location: { city: 'Anápolis', state: 'GO' },
    priority: 8,
    isDefault: true
  },

  // ═══════════════════════════════════════════════════════════════════════════
  // 🆕 NOVAS LPs 2024 - CONSOLIDAÇÃO E ESPECIALIZAÇÃO
  // ═══════════════════════════════════════════════════════════════════════════
  
  // ✅ LP CONSOLIDADA: Fala Tardia (unificada)
  {
    slug: 'fala-tardia',
    title: 'Fala Tardia Infantil',
    headline: 'Criança com atraso na fala?',
    subheadline: 'Saiba quando se preocupar e como ajudar seu filho a falar',
    category: 'fonoaudiologia',
    keywords: ['fala tardia', 'atraso fala infantil', 'criança não fala', '2 anos não fala', '3 anos não fala', 'fono Anápolis'],
    sinaisAlerta: [
      { icon: '🔇', text: 'Não fala pelo menos 20 palavras aos 2 anos' },
      { icon: '🔇', text: 'Não junta duas palavras aos 2 anos' },
      { icon: '🔇', text: 'Vocabulário muito limitado aos 3 anos' },
      { icon: '🔇', text: 'Não forma frases completas aos 3 anos' }
    ],
    content: {
      quandoProcurar: 'O atraso na fala pode ser identificado desde cedo. Aos 18 meses, a criança já deve dizer algumas palavras. Aos 2 anos, deve ter vocabulário de 50+ palavras e juntar duas palavras.',
      comoFunciona: 'Realizamos uma avaliação completa do desenvolvimento da linguagem, identificamos as dificuldades e criamos um plano terapêutico individualizado com fonoaudióloga especializada.',
      beneficios: [
        'Diagnóstico precoce do atraso na fala',
        'Plano terapêutico personalizado',
        'Acompanhamento com fonoaudióloga especializada',
        'Ambiente lúdico e acolhedor',
        'Orientação aos pais para estimulação em casa'
      ]
    },
    cta: {
      text: 'Agendar avaliação gratuita',
      link: 'https://wa.me/5562993377726?text=Oi, vi no site sobre fala tardia e gostaria de agendar uma avaliação.',
      phone: '62993377726'
    },
    seo: {
      title: 'Fala Tardia Infantil | Fonoaudiólogo em Anápolis | Fono Inova',
      description: 'Criança com atraso na fala? Saiba quando se preocupar e como a fonoaudiologia pode ajudar. Avaliação gratuita em Anápolis.',
      ogImage: '/images/og/fala-tardia.jpg'
    },
    priority: 10,
    isDefault: true,
    consolidada: true,
    urlsRedirecionadas: ['/lp/crianca-2-anos-nao-fala', '/lp/atraso-na-fala-infantil']
  },

  // ✅ LP CONSOLIDADA: Avaliação Autismo Infantil
  {
    slug: 'avaliacao-autismo-infantil',
    title: 'Avaliação de Autismo Infantil',
    headline: 'Sinais de autismo no seu filho?',
    subheadline: 'Diagnóstico precoce e intervenção especializada em Anápolis',
    category: 'autismo',
    keywords: ['autismo infantil', 'avaliação autismo', 'TEA', 'sinais autismo bebê', 'diagnóstico autismo Anápolis'],
    sinaisAlerta: [
      { icon: '👶', text: 'Não mantém contato visual' },
      { icon: '👶', text: 'Não responde ao nome' },
      { icon: '👶', text: 'Não aponta para objetos' },
      { icon: '👶', text: 'Não faz sons de balbucio' },
      { icon: '👶', text: 'Evita contato com outras crianças' },
      { icon: '👶', text: 'Movimentos repetitivos' }
    ],
    content: {
      quandoProcurar: 'Sinais de autismo podem aparecer antes dos 2 anos. Se observar comportamentos diferentes, procure uma avaliação especializada. Quanto antes o diagnóstico, melhores os resultados.',
      comoFunciona: 'Realizamos avaliação multiprofissional com psicólogo e fonoaudiólogo para diagnóstico precoce do TEA. Processo acolhedor e respeitoso com a família.',
      beneficios: [
        'Diagnóstico precoce e preciso',
        'Intervenção especializada',
        'Equipe multiprofissional',
        'Laudo válido para encaminhamentos',
        'Ambiente acolhedor'
      ]
    },
    cta: {
      text: 'Avaliação especializada',
      link: 'https://wa.me/5562993377726?text=Oi, vi no site sobre avaliação de autismo e gostaria de agendar.',
      phone: '62993377726'
    },
    seo: {
      title: 'Avaliação de Autismo Infantil | Diagnóstico TEA em Anápolis | Fono Inova',
      description: 'Sinais de autismo no seu filho? Diagnóstico precoce e intervenção especializada em Anápolis. Equipe multiprofissional e laudo válido.',
      ogImage: '/images/og/avaliacao-autismo.jpg'
    },
    priority: 10,
    isDefault: true,
    consolidada: true,
    urlsRedirecionadas: ['/lp/sinais-autismo-bebe', '/lp/sinais-autismo-2-anos']
  },

  // ✅ LP CONSOLIDADA: Dificuldade Escolar
  {
    slug: 'dificuldade-escolar',
    title: 'Dificuldade Escolar',
    headline: 'Seu filho tem dificuldade na escola?',
    subheadline: 'Identificamos as causas e criamos um plano para melhorar o desempenho escolar',
    category: 'aprendizagem',
    keywords: ['dificuldade escolar', 'baixo rendimento', 'dislexia', 'TDAH escola', 'psicopedagogia Anápolis'],
    sinaisAlerta: [
      { icon: '📚', text: 'Notas baixas mesmo estudando' },
      { icon: '📚', text: 'Troca letras ao ler/escrever' },
      { icon: '📚', text: 'Dificuldade de concentração' },
      { icon: '📚', text: 'Evita fazer lição de casa' },
      { icon: '📚', text: 'Frustração com estudos' }
    ],
    content: {
      quandoProcurar: 'Se seu filho apresenta dificuldades persistentes na escola, troca letras, tem dificuldade de concentração ou baixo rendimento, uma avaliação pode identificar dislexia, TDAH ou outras condições.',
      comoFunciona: 'Avaliação completa com neuropsicóloga e psicopedagoga para identificar as causas da dificuldade escolar e criar um plano de intervenção personalizado.',
      beneficios: [
        'Diagnóstico preciso das dificuldades',
        'Plano de intervenção personalizado',
        'Orientação para pais e escola',
        'Acompanhamento especializado',
        'Melhora no rendimento escolar'
      ]
    },
    cta: {
      text: 'Agendar avaliação',
      link: 'https://wa.me/5562993377726?text=Oi, vi no site sobre dificuldade escolar e gostaria de agendar uma avaliação.',
      phone: '62993377726'
    },
    seo: {
      title: 'Dificuldade Escolar | Avaliação em Anápolis | Fono Inova',
      description: 'Seu filho tem dificuldade na escola? Identificamos dislexia, TDAH e outras condições. Avaliação especializada em Anápolis.',
      ogImage: '/images/og/dificuldade-escolar.jpg'
    },
    priority: 9,
    isDefault: true,
    consolidada: true,
    urlsRedirecionadas: ['/lp/sinais-dislexia', '/lp/crianca-nao-aprende-ler', '/lp/crianca-troca-letras-escrita']
  },

  // 🆕 NOVA LP: Dislexia Infantil
  {
    slug: 'dislexia-infantil',
    title: 'Dislexia Infantil',
    headline: 'Seu filho confunde letras?',
    subheadline: 'Dislexia tem tratamento. Avaliação especializada em Anápolis',
    category: 'aprendizagem',
    keywords: ['dislexia infantil', 'troca b/d', 'leitura espelhada', 'dificuldade leitura', 'dislexia tratamento Anápolis'],
    sinaisAlerta: [
      { icon: '🔤', text: 'Troca letras parecidas (b/d, p/q)' },
      { icon: '🔤', text: 'Leitura espelhada' },
      { icon: '🔤', text: 'Dificuldade com ordem das letras' },
      { icon: '🔤', text: 'Leitura lenta e cansativa' },
      { icon: '🔤', text: 'Escrita com muitos erros ortográficos' }
    ],
    selecaoSerie: {
      titulo: 'Identificamos dislexia em qualquer fase:',
      opcoes: [
        { serie: '1º ano', sinais: 'Dificuldade para reconhecer letras, confunde sons parecidos' },
        { serie: '2º ano', sinais: 'Troca b/d/p/q, leitura truncada, inverte sílabas' },
        { serie: '3º ano+', sinais: 'Leitura lenta, omite palavras, compreensão baixa' }
      ]
    },
    content: {
      quandoProcurar: 'Se seu filho troca letras (b/d, p/q), tem leitura lenta e cansativa, ou dificuldade persistente com a escrita, pode ser dislexia. A intervenção antes dos 9 anos tem 90% de sucesso.',
      comoFunciona: 'Realizamos avaliação psicopedagógica completa para diagnóstico de dislexia. Usamos método fônico estruturado e terapia cognitiva adaptada ao perfil da criança.',
      beneficios: [
        'Diagnóstico preciso da dislexia',
        'Método fônico estruturado',
        'Terapia cognitiva personalizada',
        'Melhora significativa na leitura',
        'Acompanhamento escolar',
        'Maior autoestima do aluno'
      ],
      resultados: [
        { idade: '7 anos', antes: 'Não reconhecia todas as letras', depois: 'Lê textos simples com fluência', tempo: '6 meses' },
        { idade: '8 anos', antes: 'Trocava b/d constantemente', depois: 'Leitura correta e compreensão boa', tempo: '8 meses' },
        { idade: '9 anos', antes: 'Evitava ler em voz alta', depois: 'Lê com confiança na escola', tempo: '10 meses' }
      ]
    },
    cta: {
      text: 'Agendar avaliação de dislexia',
      link: 'https://wa.me/5562993377726?text=Oi, vi no site sobre dislexia infantil e gostaria de agendar uma avaliação.',
      phone: '62993377726'
    },
    seo: {
      title: 'Dislexia Infantil | Tratamento em Anápolis | Fono Inova',
      description: 'Seu filho confunde letras? Dislexia tem tratamento. Avaliação especializada e terapia personalizada em Anápolis.',
      ogImage: '/images/og/dislexia-infantil.jpg'
    },
    priority: 10,
    isDefault: true
  },

  // 🆕 NOVA LP: TDAH Infantil
  {
    slug: 'tdah-infantil',
    title: 'TDAH Infantil',
    headline: 'Seu filho é muito inquieto, não para?',
    subheadline: 'TDAH tem tratamento. Avaliação neuropsicológica especializada em Anápolis',
    category: 'neuropsicologia',
    keywords: ['TDAH infantil', 'hiperatividade', 'criança dispersa', 'falta atenção', 'TDAH tratamento Anápolis'],
    pilares: [
      { titulo: 'Desatenção', icon: '👀', descricao: 'Distrai-se fácil, esquece tarefas, dificuldade para organizar' },
      { titulo: 'Hiperatividade', icon: '⚡', descricao: 'Inquietação constante, fala excessivamente, não para quieto' },
      { titulo: 'Impulsividade', icon: '🎯', descricao: 'Age sem pensar, interrompe conversas, impaciência' }
    ],
    impactos: {
      titulo: 'Quando não tratado:',
      lista: [
        'Baixo rendimento escolar',
        'Dificuldade de socialização',
        'Frustração e baixa autoestima',
        'Conflitos familiares frequentes'
      ]
    },
    sinaisAlerta: [
      { icon: '🎯', text: 'Não consegue se concentrar nas tarefas' },
      { icon: '🎯', text: 'Esquece o que acabou de aprender' },
      { icon: '🎯', text: 'Muito inquieto, não para quieto' },
      { icon: '🎯', text: 'Age sem pensar nas consequências' },
      { icon: '🎯', text: 'Dificuldade para seguir instruções' }
    ],
    content: {
      quandoProcurar: 'Se seu filho apresenta desatenção persistente, hiperatividade ou impulsividade que afetam o desempenho escolar e as relações sociais, uma avaliação neuropsicológica pode confirmar TDAH.',
      comoFunciona: 'Avaliação completa com neuropsicóloga especializada em TDAH. Inclui testes padronizados de atenção e funções executivas, entrevistas e relatório completo com orientações.',
      beneficios: [
        'Diagnóstico preciso do TDAH',
        'Avaliação de atenção e funções executivas',
        'Plano de intervenção personalizado',
        'Orientação para pais e escola',
        'Acompanhamento especializado'
      ],
      transformacoes: [
        { titulo: 'Concentração', descricao: 'De 5 min de atenção para 30+ min nas tarefas' },
        { titulo: 'Organização', descricao: 'Aprende a organizar tarefas e materiais escolares' },
        { titulo: 'Relacionamentos', descricao: 'Melhora na interação com colegas e familiares' }
      ]
    },
    cta: {
      text: 'Agendar avaliação TDAH',
      link: 'https://wa.me/5562993377726?text=Oi, vi no site sobre TDAH infantil e gostaria de agendar uma avaliação.',
      phone: '62993377726'
    },
    seo: {
      title: 'TDAH Infantil | Avaliação em Anápolis | Fono Inova',
      description: 'Seu filho é inquieto, não consegue se concentrar? TDAH tem tratamento. Avaliação neuropsicológica especializada em Anápolis.',
      ogImage: '/images/og/tdah-infantil.jpg'
    },
    priority: 10,
    isDefault: true
  },

  // 🆕 NOVAS LPs (futuras - no sitemap)
  {
    slug: 'sindrome-de-down',
    title: 'Síndrome de Down - Acompanhamento Terapêutico',
    headline: 'Acompanhamento terapêutico para Síndrome de Down',
    subheadline: 'Intervenção precoce e multidisciplinar em Anápolis',
    category: 'desenvolvimento',
    keywords: ['síndrome de down', 'acompanhamento terapêutico', 'intervenção precoce', 'fono down'],
    sinaisAlerta: [
      { icon: '💚', text: 'Atraso no desenvolvimento da fala' },
      { icon: '💚', text: 'Dificuldade motora' },
      { icon: '💚', text: 'Atraso na alfabetização' },
      { icon: '💚', text: 'Dificuldade de socialização' }
    ],
    content: {
      quandoProcurar: 'Crianças com Síndrome de Down se beneficiam de acompanhamento multiprofissional desde o primeiro ano de vida. Quanto mais cedo começar, melhores os resultados.',
      comoFunciona: 'Oferecemos acompanhamento com fonoaudiologia, psicologia, terapia ocupacional e psicopedagogia em equipe integrada.',
      beneficios: [
        'Acompanhamento multiprofissional',
        'Intervenção precoce',
        'Desenvolvimento da fala e linguagem',
        'Autonomia e independência'
      ]
    },
    cta: {
      text: 'Agendar avaliação',
      link: 'https://wa.me/5562993377726?text=Oi, gostaria de informações sobre acompanhamento para Síndrome de Down.',
      phone: '62993377726'
    },
    seo: {
      title: 'Síndrome de Down | Acompanhamento em Anápolis | Fono Inova',
      description: 'Acompanhamento terapêutico multidisciplinar para crianças com Síndrome de Down em Anápolis.',
      ogImage: '/images/og/sindrome-down.jpg'
    },
    priority: 7,
    isDefault: true,
    emConstrucao: true
  },

  {
    slug: 'prematuridade-desenvolvimento',
    title: 'Prematuridade e Desenvolvimento Infantil',
    headline: 'Acompanhamento para bebês prematuros',
    subheadline: 'Intervenção precoce para estimular o desenvolvimento',
    category: 'desenvolvimento',
    keywords: ['prematuridade', 'bebê prematuro', 'acompanhamento prematuro', 'desenvolvimento motor'],
    sinaisAlerta: [
      { icon: '👶', text: 'Atraso no desenvolvimento motor' },
      { icon: '👶', text: 'Dificuldade de alimentação' },
      { icon: '👶', text: 'Atraso na fala' },
      { icon: '👶', text: 'Hipersensibilidade ao toque' }
    ],
    content: {
      quandoProcurar: 'Bebês prematuros precisam de acompanhamento especializado para acompanhar o desenvolvimento corrigido. A intervenção precoce é fundamental.',
      comoFunciona: 'Avaliamos o desenvolvimento neuropsicomotor e oferecemos terapias específicas para estimular as áreas que precisam de apoio.',
      beneficios: [
        'Acompanhamento do desenvolvimento corrigido',
        'Estimulação precoce',
        'Prevenção de sequelas',
        'Orientação aos pais'
      ]
    },
    cta: {
      text: 'Agendar avaliação',
      link: 'https://wa.me/5562993377726?text=Oi, gostaria de informações sobre acompanhamento para prematuridade.',
      phone: '62993377726'
    },
    seo: {
      title: 'Prematuridade | Acompanhamento em Anápolis | Fono Inova',
      description: 'Acompanhamento terapêutico especializado para bebês prematuros em Anápolis.',
      ogImage: '/images/og/prematuridade.jpg'
    },
    priority: 6,
    isDefault: true,
    emConstrucao: true
  },

  {
    slug: 'seletividade-alimentar',
    title: 'Seletividade Alimentar Infantil',
    headline: 'Criança muito seletiva na alimentação?',
    subheadline: 'Tratamento para crianças que recusam alimentos e têm dieta restrita',
    category: 'terapia_ocupacional',
    keywords: ['seletividade alimentar', 'criança não come', 'recusa alimentar', 'terapia alimentação'],
    sinaisAlerta: [
      { icon: '🍽️', text: 'Recusa consistente de alimentos' },
      { icon: '🍽️', text: 'Dieta restrita a poucos alimentos' },
      { icon: '🍽️', text: 'Reação negativa a novas texturas' },
      { icon: '🍽️', text: 'Perda de peso ou baixo crescimento' }
    ],
    content: {
      quandoProcurar: 'Se sua criança recusa alimentos de forma consistente, tem dieta restrita a menos de 20 alimentos ou apresenta estresse na hora das refeições.',
      comoFunciona: 'Avaliação da integração sensorial e processo de alimentação. Terapia ocupacional com abordagem de integração sensorial.',
      beneficios: [
        'Avaliação da integração sensorial',
        'Expansão da dieta alimentar',
        'Redução do estresse nas refeições',
        'Orientação aos pais'
      ]
    },
    cta: {
      text: 'Agendar avaliação',
      link: 'https://wa.me/5562993377726?text=Oi, gostaria de informações sobre seletividade alimentar.',
      phone: '62993377726'
    },
    seo: {
      title: 'Seletividade Alimentar | Tratamento em Anápolis | Fono Inova',
      description: 'Tratamento para crianças com seletividade alimentar em Anápolis.',
      ogImage: '/images/og/seletividade-alimentar.jpg'
    },
    priority: 7,
    isDefault: true,
    emConstrucao: true
  },

  // 🔗 LPs EXISTENTES (links atualizados)
  {
    slug: 'freio-lingual',
    title: 'Freio Lingual',
    headline: 'Seu bebê tem dificuldade para mamar?',
    subheadline: 'Avaliação e tratamento do freio lingual em Anápolis',
    category: 'fonoaudiologia',
    keywords: ['freio lingual', 'língua presa', 'dificuldade amamentação', 'freio curto bebê'],
    sinaisAlerta: [
      { icon: '👅', text: 'Dificuldade para sugar' },
      { icon: '👅', text: 'Mamadas prolongadas' },
      { icon: '👅', text: 'Dor ao amamentar' },
      { icon: '👅', text: 'Bebê não ganha peso' }
    ],
    content: {
      quandoProcurar: 'Se seu bebê tem dificuldade para mamar, a avaliação do freio lingual pode identificar se há restrição da língua.',
      comoFunciona: 'Avaliação completa com protocolo MBGR para identificar restrição do freio lingual e orientação sobre o tratamento mais adequado.',
      beneficios: [
        'Avaliação com protocolo MBGR',
        'Orientação especializada',
        'Melhora na amamentação',
        'Prevenção de problemas futuros'
      ]
    },
    cta: {
      text: 'Agendar avaliação',
      link: 'https://wa.me/5562993377726?text=Oi, vi no site sobre freio lingual e gostaria de agendar uma avaliação.',
      phone: '62993377726'
    },
    seo: {
      title: 'Freio Lingual | Avaliação em Anápolis | Fono Inova',
      description: 'Avaliação e tratamento do freio lingual em Anápolis. Protocolo MBGR e orientação especializada.',
      ogImage: '/images/og/freio-lingual.jpg'
    },
    priority: 8,
    isDefault: true
  },

  {
    slug: 'fonoaudiologia-adulto',
    title: 'Fonoaudiologia Adulto',
    headline: 'Problemas de voz ou fala?',
    subheadline: 'Atendimento fonoaudiológico para adultos em Anápolis',
    category: 'fonoaudiologia',
    keywords: ['fonoaudiologia adulto', 'problemas voz', 'gagueira adulto', 'fono adulto Anápolis'],
    sinaisAlerta: [
      { icon: '🗣️', text: 'Rouquidão persistente' },
      { icon: '🗣️', text: 'Dificuldade de falar em público' },
      { icon: '🗣️', text: 'Gagueira' },
      { icon: '🗣️', text: 'Voz fraca ou cansada' }
    ],
    content: {
      quandoProcurar: 'Problemas de voz, fala ou linguagem em adultos também têm tratamento fonoaudiológico.',
      comoFunciona: 'Avaliação e tratamento personalizado para cada necessidade, seja voz, fluência ou linguagem.',
      beneficios: [
        'Avaliação especializada',
        'Tratamento personalizado',
        'Melhora da comunicação',
        'Qualidade de vida'
      ]
    },
    cta: {
      text: 'Agendar avaliação',
      link: 'https://wa.me/5562993377726?text=Oi, vi no site sobre fonoaudiologia adulto e gostaria de agendar uma avaliação.',
      phone: '62993377726'
    },
    seo: {
      title: 'Fonoaudiologia Adulto | Atendimento em Anápolis | Fono Inova',
      description: 'Fonoaudiologia para adultos em Anápolis. Tratamento de voz, fluência e linguagem.',
      ogImage: '/images/og/fono-adulto.jpg'
    },
    priority: 6,
    isDefault: true
  }
];

// ═══════════════════════════════════════════════════════════════════════════════
// 🎯 FUNÇÕES DO SERVICE
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Seed inicial - popula o banco com as 20+ LPs
 */
export async function seedLandingPages() {
  try {
    console.log('🌱 Iniciando seed de Landing Pages...');
    
    let created = 0;
    let skipped = 0;
    
    for (const lpData of LANDING_PAGES_DATA) {
      const existing = await LandingPage.findOne({ slug: lpData.slug });
      
      if (!existing) {
        await LandingPage.create(lpData);
        created++;
        console.log(`  ✓ Criada: ${lpData.slug}`);
      } else {
        skipped++;
        console.log(`  ⏭️  Pulada (já existe): ${lpData.slug}`);
      }
    }
    
    console.log(`✅ Seed completo: ${created} criadas, ${skipped} puladas`);
    return { created, skipped, total: LANDING_PAGES_DATA.length };
  } catch (error) {
    console.error('❌ Erro no seed:', error);
    throw error;
  }
}

/**
 * Busca LP do dia (uma de cada categoria)
 */
export async function getLandingPageOfTheDay() {
  const categories = ['fonoaudiologia', 'autismo', 'psicologia', 'aprendizagem', 'terapia_ocupacional', 'neuropsicologia', 'desenvolvimento'];
  const dailyPages = {};
  
  // Usa o dia do ano para manter consistente durante o dia
  const dayOfYear = Math.floor((new Date() - new Date(new Date().getFullYear(), 0, 0)) / (1000 * 60 * 60 * 24));
  
  for (const category of categories) {
    const pages = await LandingPage.find({ category, status: 'active' });
    
    if (pages.length > 0) {
      // Seleciona baseado no dia do ano para rotacionar
      const index = dayOfYear % pages.length;
      dailyPages[category] = pages[index];
    }
  }
  
  return dailyPages;
}

/**
 * Busca rotação semanal
 */
export async function getRotationForWeek() {
  const categories = ['fonoaudiologia', 'autismo', 'psicologia', 'aprendizagem', 'terapia_ocupacional', 'neuropsicologia', 'desenvolvimento'];
  const weekPlan = [];
  
  // Gera plano para os próximos 7 dias
  for (let i = 0; i < 7; i++) {
    const date = new Date();
    date.setDate(date.getDate() + i);
    
    const dayPlan = {
      date: date.toISOString().split('T')[0],
      pages: {}
    };
    
    for (const category of categories) {
      const pages = await LandingPage.find({ category, status: 'active' });
      
      if (pages.length > 0) {
        // Seleciona baseado no dia
        const dayOfYear = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / (1000 * 60 * 60 * 24));
        const index = (dayOfYear + i) % pages.length;
        dayPlan.pages[category] = {
          slug: pages[index].slug,
          title: pages[index].title,
          headline: pages[index].headline
        };
      }
    }
    
    weekPlan.push(dayPlan);
  }
  
  return weekPlan;
}

/**
 * Sugere LPs para posts (menos usadas recentemente)
 */
export async function suggestForPost(category = null, limit = 5) {
  const query = { status: 'active' };
  
  if (category && category !== 'all') {
    query.category = category;
  }
  
  // Busca LPs ordenadas por uso (menos usadas primeiro)
  return LandingPage.find(query)
    .sort({ postCount: 1, priority: -1 })
    .limit(limit)
    .select('slug title headline category keywords seo.title');
}

/**
 * Marca LP como usada em post
 */
export async function markAsUsed(slug) {
  const lp = await LandingPage.findOne({ slug });
  
  if (!lp) {
    throw new Error('Landing page não encontrada');
  }
  
  lp.lastUsedInPost = new Date();
  lp.postCount += 1;
  await lp.save();
  
  return lp;
}

/**
 * Incrementa métricas
 */
export async function incrementMetrics(slug, type) {
  const update = {};
  
  if (type === 'view') {
    update.$inc = { 'metrics.views': 1 };
  } else if (type === 'lead') {
    update.$inc = { 'metrics.leads': 1 };
  }
  
  const lp = await LandingPage.findOneAndUpdate(
    { slug },
    update,
    { new: true }
  );
  
  if (lp && lp.metrics.views > 0) {
    lp.metrics.conversionRate = (lp.metrics.leads / lp.metrics.views) * 100;
    await lp.save();
  }
  
  return lp;
}

/**
 * Gera conteúdo sugerido para post do GMB
 */
export async function generatePostContent(slug) {
  const lp = await LandingPage.findOne({ slug });
  
  if (!lp) {
    throw new Error('Landing page não encontrada');
  }
  
  // 🎯 Gera sugestão de post baseado na LP com SEO otimizado
  // Usa dados de SEO da landing page para melhor ranqueamento
  const seoTitle = lp.seo?.title || lp.title;
  const seoDescription = lp.seo?.description || lp.subheadline;
  const keywords = lp.keywords?.slice(0, 3).join(', ') || '';
  const whatsappNumber = '(62) 99337-7726'; // Número correto da clínica
  
  const postTemplates = [
    {
      // Template 1: Foco em SEO com headline + keywords
      title: `${lp.headline} | ${lp.category.charAt(0).toUpperCase() + lp.category.slice(1)} em Anápolis`,
      content: `${seoDescription}\n\n${lp.sinaisAlerta.slice(0, 3).map(s => `${s.icon} ${s.text}`).join('\n')}\n\n✅ ${lp.content.comoFunciona?.substring(0, 100) || 'Avaliação especializada para entender as necessidades da sua criança.'}\n\n🔍 Palavras-chave: ${keywords}\n\n👉 Saiba mais: clinicafonoinova.com.br/lp/${lp.slug}\n\n📱 Agende sua avaliação gratuita: ${whatsappNumber}`
    },
    {
      // Template 2: Educativo com foco em beneficios
      title: `Você sabia? ${lp.title} em Anápolis`,
      content: `Muitos pais em Anápolis têm essa mesma dúvida sobre ${lp.category.toLowerCase()}.\n\n${lp.content.quandoProcurar?.substring(0, 120) || seoDescription.substring(0, 120)}...\n\n💡 ${lp.content.beneficios?.[0] || 'Diagnóstico precoce é fundamental para o desenvolvimento infantil.'}\n\n🎯 Especialistas em: ${keywords}\n\n🔗 Conheça nossa LP: clinicafonoinova.com.br/lp/${lp.slug}\n\n💚 Clínica Fono Inova - Centro de Desenvolvimento Infantil\n📍 Anápolis - GO\n📞 ${whatsappNumber}`
    },
    {
      // Template 3: Urgência + CTA forte
      title: `⚠️ ${lp.headline} - Não ignore os sinais`,
      content: `Fique atento aos sinais de alerta em ${lp.category.toLowerCase()}:\n\n${lp.sinaisAlerta.map(s => `${s.icon} ${s.text}`).join('\n')}\n\n🚨 Se identificou algum desses sinais, procure ajuda especializada!\n\n✨ ${lp.content.beneficios?.slice(0, 2).join(' ').substring(0, 100) || 'Nossa equipe está preparada para ajudar seu filho.'}\n\n📋 Mais informações: clinicafonoinova.com.br/lp/${lp.slug}\n\n📞 WhatsApp para agendamento: ${whatsappNumber}\n\n#${lp.category.replace(/_/g, '')} #Anápolis #DesenvolvimentoInfantil #${lp.keywords?.[0]?.replace(/\s+/g, '') || 'FonoInova'}`
    }
  ];
  
  // Retorna template aleatório
  const randomTemplate = postTemplates[Math.floor(Math.random() * postTemplates.length)];
  
  return {
    ...randomTemplate,
    landingPageSlug: lp.slug,
    landingPageUrl: `https://clinicafonoinova.com.br/lp/${lp.slug}`,
    category: lp.category,
    suggestedCta: 'BOOK'
  };
}

/**
 * Busca estatísticas gerais
 */
export async function getStats() {
  const total = await LandingPage.countDocuments({ status: 'active' });
  
  const byCategory = await LandingPage.aggregate([
    { $match: { status: 'active' } },
    { $group: { _id: '$category', count: { $sum: 1 } } }
  ]);
  
  const mostUsed = await LandingPage.find({ status: 'active' })
    .sort({ postCount: -1 })
    .limit(5)
    .select('slug title postCount metrics.views metrics.leads');
  
  const totalViews = await LandingPage.aggregate([
    { $group: { _id: null, total: { $sum: '$metrics.views' } } }
  ]);
  
  const totalLeads = await LandingPage.aggregate([
    { $group: { _id: null, total: { $sum: '$metrics.leads' } } }
  ]);
  
  return {
    total,
    byCategory: byCategory.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {}),
    mostUsed,
    totalViews: totalViews[0]?.total || 0,
    totalLeads: totalLeads[0]?.total || 0,
    averageConversion: totalViews[0]?.total > 0 
      ? ((totalLeads[0]?.total || 0) / totalViews[0].total * 100).toFixed(2)
      : 0
  };
}

export default {
  seedLandingPages,
  getLandingPageOfTheDay,
  getRotationForWeek,
  suggestForPost,
  markAsUsed,
  incrementMetrics,
  generatePostContent,
  getStats,
  LANDING_PAGES_DATA
};
