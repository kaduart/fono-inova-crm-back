import mongoose from 'mongoose';
import TherapyProtocol from '../models/TherapyProtocol.js';
import dotenv from 'dotenv';
dotenv.config();

const protocols = [
  // ========== PSICOLOGIA ==========
  {
    code: 'PSI-TCC-001',
    name: 'TCC para Ansiedade Infantil',
    specialty: 'Psicologia',
    applicableAreas: ['cognitive', 'behavior'],
    description: 'Terapia Cognitivo-Comportamental adaptada para crianças com transtornos de ansiedade.',
    typicalDuration: '12-16 sessões',
    keyTechniques: [
      'Psicoeducação sobre ansiedade',
      'Reestruturação cognitiva',
      'Exposição gradual',
      'Técnicas de relaxamento',
      'Treino de habilidades sociais'
    ],
    measurableGoals: [
      'Reduzir sintomas de ansiedade em 50% (escala SCARED)',
      'Identificar e nomear 5+ emoções diferentes',
      'Utilizar 3+ estratégias de enfrentamento',
      'Aumentar participação em atividades sociais'
    ],
    references: [
      { title: 'Terapia Cognitivo-Comportamental na Infância - Stallard', type: 'book' },
      { title: 'Manual TCC para Crianças e Adolescentes', type: 'article' }
    ]
  },
  {
    code: 'PSI-LUDO-001',
    name: 'Ludoterapia Centrada na Criança',
    specialty: 'Psicologia',
    applicableAreas: ['behavior', 'social', 'cognitive'],
    description: 'Abordagem terapêutica que utiliza o brincar como forma de expressão e elaboração emocional.',
    typicalDuration: '20-30 sessões',
    keyTechniques: [
      'Brincar livre',
      'Reflexão de sentimentos',
      'Estabelecimento de limites terapêuticos',
      'Uso de metáforas e histórias'
    ],
    measurableGoals: [
      'Aumentar expressão emocional adequada',
      'Reduzir comportamentos agressivos em 60%',
      'Melhorar autorregulação emocional',
      'Desenvolver repertório de brincadeiras simbólicas'
    ]
  },
  {
    code: 'PSI-DBT-001',
    name: 'DBT Adaptada para Adolescentes',
    specialty: 'Psicologia',
    applicableAreas: ['behavior', 'cognitive'],
    description: 'Terapia Comportamental Dialética focada em regulação emocional para adolescentes.',
    typicalDuration: '16-20 sessões',
    keyTechniques: [
      'Mindfulness',
      'Tolerância ao mal-estar',
      'Regulação emocional',
      'Efetividade interpessoal'
    ],
    measurableGoals: [
      'Reduzir episódios de desregulação emocional em 70%',
      'Identificar gatilhos emocionais',
      'Usar 4+ habilidades de DBT no dia a dia'
    ]
  },

  // ========== TERAPIA OCUPACIONAL ==========
  {
    code: 'TO-IS-001',
    name: 'Integração Sensorial (Ayres)',
    specialty: 'Terapia Ocupacional',
    applicableAreas: ['motor', 'behavior', 'cognitive'],
    description: 'Abordagem para crianças com dificuldades de processamento sensorial baseada na teoria de Jean Ayres.',
    typicalDuration: '20-30 sessões',
    keyTechniques: [
      'Atividades vestibulares e proprioceptivas',
      'Estimulação tátil graduada',
      'Desafios motores adaptativos',
      'Brincadeiras em suspensão'
    ],
    measurableGoals: [
      'Melhorar modulação sensorial em 60%',
      'Reduzir hipersensibilidade tátil',
      'Aumentar participação em atividades escolares',
      'Melhorar coordenação motora grossa'
    ],
    references: [
      { title: 'Sensory Integration and the Child - Ayres', type: 'book' }
    ]
  },
  {
    code: 'TO-COOP-001',
    name: 'Modelo CO-OP',
    specialty: 'Terapia Ocupacional',
    applicableAreas: ['cognitive', 'motor'],
    description: 'Abordagem cognitiva para aprendizagem de habilidades motoras através de resolução de problemas.',
    typicalDuration: '10-12 sessões',
    keyTechniques: [
      'Estabelecimento de objetivos com a criança',
      'Descoberta guiada',
      'Estratégias cognitivas (Goal-Plan-Do-Check)',
      'Generalização de habilidades'
    ],
    measurableGoals: [
      'Criança define 3+ objetivos funcionais',
      'Atingir independência em 2+ AVDs',
      'Usar estratégias de resolução de problemas',
      'Transferir habilidades para novos contextos'
    ]
  },
  {
    code: 'TO-AVD-001',
    name: 'Treino de Atividades de Vida Diária',
    specialty: 'Terapia Ocupacional',
    applicableAreas: ['motor', 'cognitive'],
    description: 'Programa focado em independência nas atividades do dia a dia.',
    typicalDuration: '12-16 sessões',
    keyTechniques: [
      'Análise e adaptação de atividades',
      'Treino de sequenciamento',
      'Uso de recursos adaptativos',
      'Prática em contexto real'
    ],
    measurableGoals: [
      'Independência em 3+ AVDs (banho, vestir, alimentação)',
      'Reduzir tempo de execução em 50%',
      'Usar adaptações de forma autônoma'
    ]
  },

  // ========== FONOAUDIOLOGIA ==========
  {
    code: 'FONO-PROMPT-001',
    name: 'PROMPT para Apraxia de Fala',
    specialty: 'Fonoaudiologia',
    applicableAreas: ['language', 'motor'],
    description: 'Abordagem tátil-cinestésica para tratamento de apraxia de fala infantil.',
    typicalDuration: '30-40 sessões (2-3x/semana)',
    keyTechniques: [
      'Toques manuais específicos',
      'Hierarquia de complexidade motora',
      'Integração de fonação, articulação e prosódia',
      'Prática massiva e distribuída'
    ],
    measurableGoals: [
      'Aumentar inteligibilidade de fala em 60%',
      'Produzir 10+ palavras funcionais',
      'Melhorar sequenciamento motor oral',
      'Reduzir frustração comunicativa'
    ],
    references: [
      { title: 'PROMPT Institute - Certification Manual', type: 'article' }
    ]
  },
  {
    code: 'FONO-HANEN-001',
    name: 'Programa Hanen (It Takes Two to Talk)',
    specialty: 'Fonoaudiologia',
    applicableAreas: ['language', 'social'],
    description: 'Programa centrado na família para crianças com atraso de linguagem.',
    typicalDuration: '8-10 sessões com pais',
    keyTechniques: [
      'Estratégias OWL (Observe, Wait, Listen)',
      'Expansão e extensão de linguagem',
      'Comunicação responsiva',
      'Criação de oportunidades comunicativas'
    ],
    measurableGoals: [
      'Aumentar vocabulário expressivo em 50 palavras',
      'Iniciar comunicação espontânea',
      'Pais usarem 5+ estratégias Hanen',
      'Melhorar turnos comunicativos'
    ]
  },
  {
    code: 'FONO-PECS-001',
    name: 'PECS - Sistema de Comunicação por Troca de Figuras',
    specialty: 'Fonoaudiologia',
    applicableAreas: ['language', 'social'],
    description: 'Sistema de comunicação alternativa para crianças não-verbais ou com fala emergente.',
    typicalDuration: '6 fases, 20-30 sessões',
    keyTechniques: [
      'Troca física de figuras',
      'Distância e persistência',
      'Discriminação de figuras',
      'Estrutura de sentença',
      'Transição para fala'
    ],
    measurableGoals: [
      'Completar Fase 3 do PECS',
      'Fazer 20+ pedidos espontâneos/dia',
      'Criar sentenças de 3+ elementos',
      'Generalizar uso em múltiplos ambientes'
    ]
  },
  {
    code: 'FONO-OMT-001',
    name: 'Terapia Miofuncional Orofacial',
    specialty: 'Fonoaudiologia',
    applicableAreas: ['motor'],
    description: 'Tratamento de alterações nas funções orofaciais (respiração, mastigação, deglutição, fala).',
    typicalDuration: '12-16 sessões',
    keyTechniques: [
      'Exercícios de fortalecimento orofacial',
      'Adequação postural',
      'Treino de mastigação e deglutição',
      'Exercícios de mobilidade lingual'
    ],
    measurableGoals: [
      'Estabelecer respiração nasal',
      'Melhorar vedamento labial',
      'Adequar padrão mastigatório',
      'Reduzir escape de saliva em 90%'
    ]
  },
  {
    code: 'FONO-CAA-001',
    name: 'CAA - Comunicação Alternativa e Aumentativa',
    specialty: 'Fonoaudiologia',
    applicableAreas: ['language', 'social', 'cognitive'],
    description: 'Sistema multimodal de comunicação para pessoas com necessidades complexas de comunicação.',
    typicalDuration: '20-40 sessões (varia por tecnologia)',
    keyTechniques: [
      'Avaliação de necessidades comunicativas',
      'Seleção de sistema CAA apropriado',
      'Treino de parceiros comunicativos',
      'Modelagem de uso de CAA',
      'Integração de múltiplas modalidades (gestos, figuras, voz, tecnologia)'
    ],
    measurableGoals: [
      'Estabelecer sistema CAA funcional',
      'Fazer 30+ comunicações espontâneas/dia',
      'Família e escola usarem CAA consistentemente',
      'Expandir funções comunicativas (pedido, comentário, pergunta)',
      'Aumentar participação social em 70%'
    ],
    references: [
      { title: 'Light & McNaughton - AAC Research', type: 'article' },
      { title: 'ASHA - Augmentative and Alternative Communication', type: 'article' }
    ]
  },

  // ========== FISIOTERAPIA ==========
  {
    code: 'FISIO-BOBATH-001',
    name: 'Conceito Bobath/NDT',
    specialty: 'Fisioterapia',
    applicableAreas: ['motor'],
    description: 'Abordagem neuroevolutiva para crianças com alterações do desenvolvimento motor.',
    typicalDuration: '30-40 sessões (2x/semana)',
    keyTechniques: [
      'Facilitação de movimentos normais',
      'Inibição de padrões patológicos',
      'Estimulação sensório-motora',
      'Treino de transições posturais',
      'Fortalecimento funcional'
    ],
    measurableGoals: [
      'Atingir 2+ marcos motores (GMFM)',
      'Melhorar controle de tronco',
      'Aumentar amplitude de movimento em 30%',
      'Reduzir tônus espástico'
    ]
  },
  {
    code: 'FISIO-ESTIM-001',
    name: 'Estimulação Precoce',
    specialty: 'Fisioterapia',
    applicableAreas: ['motor', 'cognitive'],
    description: 'Programa de intervenção para bebês de risco ou com atraso no desenvolvimento.',
    typicalDuration: '20-30 sessões',
    keyTechniques: [
      'Estimulação sensório-motora',
      'Orientação aos pais',
      'Posicionamento terapêutico',
      'Facilitação de marcos motores',
      'Integração de reflexos primitivos'
    ],
    measurableGoals: [
      'Alcançar marcos motores esperados',
      'Melhorar interação com ambiente',
      'Pais executarem 5+ atividades em casa',
      'Normalizar tônus muscular'
    ]
  }
];

const seedProtocols = async () => {
  try {
    if (!process.env.MONGO_URI) {
      console.error('❌ ERRO: MONGO_URI não encontrado no .env');
      console.log('📝 Adicione ao .env:');
      console.log('   MONGO_URI=sua_connection_string_aqui');
      process.exit(1);
    }

    // Mostrar banco que será usado (mascarar credenciais)
    const cleanUri = process.env.MONGO_URI.replace(/\/\/.*@/, '//***@');
    console.log(`📡 Conectando: ${cleanUri}`);
    
    await mongoose.connect(process.env.MONGO_URI);
    
    const dbName = mongoose.connection.db.databaseName;
    console.log(`✅ Conectado ao banco: "${dbName}"`);

    // Limpar coleção existente
    const deleted = await TherapyProtocol.deleteMany({});
    console.log(`🗑️  ${deleted.deletedCount} protocolos antigos removidos`);

    // Inserir novos protocolos
    const inserted = await TherapyProtocol.insertMany(protocols);
    console.log(`✅ ${inserted.length} protocolos inseridos com sucesso`);

    // Mostrar resumo por especialidade
    const summary = await TherapyProtocol.aggregate([
      {
        $group: {
          _id: '$specialty',
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    console.log('\n📊 Resumo por especialidade:');
    summary.forEach(s => {
      console.log(`   ${s._id}: ${s.count} protocolos`);
    });

    // Validar inserção
    console.log(`\n🔍 Validação:`);
    const count = await TherapyProtocol.countDocuments();
    console.log(`   Total no banco "${dbName}": ${count} protocolos`);

    console.log('\n🎯 Próximos passos:');
    console.log('   1. Testar: GET /api/protocols');
    console.log('   2. Criar evolução: POST /api/evolutions (com protocolCode)');
    console.log('   3. Ver progresso: GET /api/evolutions/patient/:id/progress');
    
    console.log('\n⚠️  IMPORTANTE:');
    console.log(`   Certifique-se que sua aplicação usa o mesmo banco: "${dbName}"`);
    console.log(`   Verifique MONGO_URI no .env da aplicação`);

    process.exit(0);
  } catch (error) {
    console.error('❌ Erro ao inserir protocolos:', error);
    process.exit(1);
  }
};

seedProtocols();