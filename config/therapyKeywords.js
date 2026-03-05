/**
 * 🏥 THERAPY KEYWORDS - Detecção Robusta de Áreas Terapêuticas
 * 
 * Lista abrangente de termos para cada área, incluindo:
 * - Nomes completos e abreviações
 * - Termos técnicos populares
 * - Variações de gênero (profissional/profissionala)
 * - Erros comuns de digitação
 */

const THERAPY_KEYWORDS = {
    fonoaudiologia: {
        primary: [
            'fonoaudiologia', 'fonoaudiologo', 'fonoaudiologa', 'fonoaudiólogo', 'fonoaudióloga',
            'fono', 'fonoáudiologia', 'fonoáudiologo', 'fonoáudiologa',
            'fonoaudilogo', 'fonoaudilogia'
        ],
        related: [
            'audiologia', 'audiologo', 'audiologa', 'audiólogo', 'audióloga',
            'linguagem', 'fala', 'falar', 'voz', 'vocal', 'deglutição', 'mastigação',
            'motricidade orofacial', 'oro facial', 'miofuncional', 'miofuncional orofacial',
            'linguinha', 'freio da língua', 'frenulo', 'freio', 'lábio leporino', 'fenda palatina',
            'fissura labiopalatina', 'lábio', 'palato', 'respiração oral', 'respirador oral',
            'nariz aberto', 'voz rouca', 'rouquidão', 'pregas vocais', 'cordas vocais',
            'gagueira', 'gaguej', 'tartamudez', 'fluencia', 'fluência',
            'engasgar', 'engasgando', 'baba', 'babando', 'salivação',
            'mamar', 'amamentação', 'peito', 'seio', 'chupeta', 'chupar dedo',
            'lactação', 'dificuldade para mamar', 'succao', 'sucção'
        ]
    },

    psicologia: {
        primary: [
            'psicologia', 'psicologo', 'psicologa', 'psicólogo', 'psicóloga',
            'psicoterapia', 'psicoterapeuta', 'terapia', 'acompanhamento psicologico'
        ],
        related: [
            'comportamento', 'comportamental', 'birra', 'birras', 'manhãzinha',
            'não obedece', 'desobedece', 'obediência', 'agressivo', 'agressividade',
            'bate em', 'bateu', 'morde', 'socou', 'briga', 'brigar',
            'ansiedade', 'ansiosa', 'ansioso', 'nervoso', 'nervosismo',
            'medo', 'temor', 'fobia', 'fobico', 'fóbico', 'medroso',
            'depressão', 'depressivo', 'deprimido', 'triste', 'choroso', 'chora muito',
            'não dorme', 'insônia', 'insonia', 'pesadelo', 'pesadelos', 'terror noturno',
            'reclama', 'reclamação', 'mimimi', 'birrento', 'birração',
            'não aceita', 'teimosia', 'teimoso', 'autoridade', 'limites',
            'queima roupa', 'encoprese', 'suja roupa', 'fezes', 'cocô',
            'enurese', 'xixi na cama', 'faz xixi na cama', 'micção', 'urina',
            'se borra', 'incontinência', 'incontinencia',
            'autolesão', 'automutilação', 'se corta', 'bate na cabeça',
            'toc', 'transtorno obsessivo', 'ritual', 'mania', 'manias',
            'seletividade alimentar', 'não come', 'recusa alimentar',
            'separação', 'ansiedade de separação', 'apego excessivo',
            'socialização', 'socializar', 'isolamento', 'isolado', 'tímido', 'timidez',
            'humor', 'mudança de humor', 'irritabilidade', 'irritado'
        ]
    },

    terapia_ocupacional: {
        primary: [
            'terapia ocupacional', 'terapeuta ocupacional', 'to',
            'terapiaocupacional', 'terapeutocupacional'
        ],
        related: [
            'ocupacional', 'terapia ocup', 't.o', 't. o',
            'integração sensorial', 'integracao sensorial', 'si',
            'sensorial', 'sensoriais', 'hipersensível', 'hipersensivel', 'hipersensibilidade',
            'textura', 'barulho', 'som', 'luz', 'cheiro', 'olfato', 'tato',
            'intolerância sensorial', 'intolerancia sensorial', 'evita contato',
            'não gosta de toque', 'não gosta de tocar', 'aversão tátil',
            'coordenação motora', 'coordenação', 'coordenacao', 'motricidade', 'motora',
            'motricidade fina', 'motricidade grossa', 'movimento', 'movimentos',
            'segurar lápis', 'segurar caneta', 'amarrar cadarço', 'amarrar sapatos',
            'botão', 'botar botão', 'zíper', 'ziper', 'fechar zíper',
            'escovar dentes', 'escovação', 'higiene pessoal',
            'tomar banho', 'banho', 'banhar', 'medo de banho',
            'vestir', 'vestir-se', 'vestir sozinho', 'trocar de roupa',
            'alimentação', 'alimentacao', 'comer sozinho', 'comer sozinha',
            'pinça', 'pinça digital', 'lateralidade', 'esquerda', 'direita',
            'canhoto', 'canhota', 'destro', 'destra', 'dominância', 'dominancia',
            'reflexos', 'reflexos primitivos', 'reflexo', 'tonus', 'tônus',
            'avd', 'atividades de vida diária', 'avidas',
            'brincar', 'brincadeira', 'interação', 'interacao', 'lazer',
            'organização', 'organizacao', 'planejamento', 'executar tarefas'
        ]
    },

    fisioterapia: {
        primary: [
            'fisioterapia', 'fisioterapeuta', 'fisio', 'fisioterapia infantil',
            'fisioterapia neurofuncional', 'fisio neuro', 'fisioterapeuta pediatrico'
        ],
        related: [
            'atraso motor', 'desenvolvimento motor', 'desenvolvimento psicomotor',
            'não engatinhou', 'não engatinha', 'engatinhar',
            'não andou', 'não anda', 'começou a andar tarde', 'andar tarde',
            'andar na ponta', 'andar de pontinha', 'andar na pontinha', 'pé torto', 'pe torto',
            'torticolo', 'torticolis', 'torcicolo', 'assimetria', 'preferência lateral',
            'prematuro', 'prematuridade', 'prematura', 'recem nascido', 'recém-nascido', 'rn',
            'hipotonia', 'flacidez', 'moleza', 'musculo flacido',
            'hipertonia', 'espasticidade', 'rigidez', 'tonus aumentado', 'tônus aumentado',
            'fortalecimento', 'fortalecer', 'equilíbrio', 'equilibrio', 'cair', 'cai muito', 'quedas',
            'tropeça', 'tropeca', 'tropeçar', 'postura', 'postural', 'escoliose', 'cifose', 'coluna',
            'posição sentada', 'sentar', 'sentar sozinho', 'rolar', 'rolamento',
            'rastejar', 'arrastar', 'posição de pe', 'posição de pé', 'ficar em pé',
            'caminhar', 'marcha', 'andar', 'correr', 'pular', 'escalar',
            'paralisia', 'paralisia cerebral', 'pc', 'sindrome de down', 'sd'
        ]
    },

    neuropsicologia: {
        primary: [
            'neuropsicologia', 'neuropsicólogo', 'neuropsicóloga', 'neuropsicologo', 'neuropsicologa',
            'neuropsico', 'neuro psi', 'neuropsi', 'avaliação neuropsicológica', 'avaliação neuropsicologica',
            'avaliação neuropsicológica infantil', 'avaliação neuropsicologica infantil'
        ],
        related: [
            'neuro', 'neurologia', 'neurologico', 'neurológico', 'neurologista',
            'laudo', 'laudo neuropsicológico', 'emitir laudo', 'precisa de laudo',
            'teste de qi', 'teste qi', 'teste de quociente', 'inteligência', 'qi',
            'funções executivas', 'funcoes executivas', 'atencao', 'atenção',
            'memória', 'memoria', 'concentração', 'concentracao', 'foco',
            'dificuldade de aprendizagem', 'dificuldade de aprendizado', 'dificuldade escolar',
            'dislexia', 'dislexico', 'disléxico', 'troca letras', 'troca sílabas',
            'discalculia', 'dificuldade com números', 'dificuldade em matemática',
            'tdah', 'tda', 'déficit de atenção', 'deficit de atencao', 'hiperatividade',
            'desatento', 'não presta atenção', 'distraído', 'distracao', 'distração',
            'não para quieto', 'agitação', 'agitado', 'impulsividade', 'impulsivo',
            'rendimento escolar', 'nota baixa', 'reprovação', 'reprovou', 'reprovado',
            'superdotação', 'superdotado', 'superdotada', 'altas habilidades', 'ah', 'gh', 'gifted',
            'tea', 'autismo', 'transtorno do espectro autista', 'espectro autista', 'asperger',
            'avaliação cognitiva', 'funcionamento cognitivo', 'processamento',
            'neurodesenvolvimento', 'transtorno do neurodesenvolvimento',
            'avaliação psicopedagógica', 'avaliação psicopedagogica'
        ]
    },

    musicoterapia: {
        primary: [
            'musicoterapia', 'musicoterapeuta', 'musicoterapia infantil',
            'musicoterapia hospitalar', 'musicoterapia comunitaria'
        ],
        related: [
            'música', 'musica', 'musical', 'musicalidade', 'ritmo', 'melodia',
            'instrumento musical', 'cantar', 'canto', 'vocalização', 'sons',
            'estimulação sonora', 'estimulação musical', 'audicao', 'audição musical',
            'comunicação alternativa', 'expressão', 'expressão emocional',
            'desenvolvimento musical', 'percepção musical', 'percepcao musical'
        ]
    },

    psicopedagogia: {
        primary: [
            'psicopedagogia', 'psicopedagogo', 'psicopedagoga',
            'psicopedagogia clinica', 'psicopedagogia institucional'
        ],
        related: [
            'reforço escolar', 'reforço', 'reforco escolar', 'reforco',
            'acompanhamento escolar', 'apoio escolar', 'apoio pedagógico',
            'dificuldade escolar', 'dificuldade de aprendizagem', 'dificuldade de aprender',
            'alfabetização', 'alfabetizacao', 'ler', 'escrever', 'leitura', 'escrita',
            'matemática', 'matematica', 'calculo', 'cálculo', 'resolucao de problemas',
            'organização escolar', 'rotina de estudos', 'metodo de estudo',
            'preparatório', 'preparatorio', 'vestibular', 'enem',
            'adaptação curricular', 'adaptacao curricular', 'pei', 'plano de ensino individualizado'
        ]
    }
};

// Sinônimos e termos que podem indicar múltiplas áreas
const AMBIGUOUS_TERMS = {
    'tdah': ['neuropsicologia', 'psicologia'],
    'autismo': ['neuropsicologia', 'psicologia', 'terapia_ocupacional', 'fonoaudiologia'],
    'tea': ['neuropsicologia', 'psicologia', 'terapia_ocupacional', 'fonoaudiologia'],
    'desenvolvimento': ['fisioterapia', 'terapia_ocupacional', 'fonoaudiologia', 'psicologia'],
    'atraso': ['fisioterapia', 'fonoaudiologia', 'terapia_ocupacional', 'neuropsicologia'],
    'bebe': ['fisioterapia', 'fonoaudiologia', 'terapia_ocupacional'],
    'criança': ['todas']
};

// Cria regex a partir dos termos
const createRegex = (terms) => {
    const escaped = terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp('\\b(' + escaped.join('|') + ')\\b', 'i');
};

// 🔥 FLAGS DE EMPREGO/CURRÍCULO - Centralizado
const JOB_KEYWORDS = {
    curriculum: ['curriculo', 'currículo', 'curriculum', 'cv', 'enviar curriculo', 'enviar currículo'],
    job: ['emprego', 'trabalho', 'vaga', 'vagas', 'trampo', 'estágio', 'estagio', 'estagiario', 'estagiária', 'estagiário'],
    search: ['procura', 'procurando', 'busca', 'buscando', 'precisa', 'necessidade', 'oportunidade', 'oportunidades'],
    action: ['trabalhar', 'trabalha', 'atuante', 'atuar', 'fazer parte', 'integrar', 'enviar'],
    partnership: ['parceria', 'credenciamento', 'prestador', 'prestadora', 'convênio', 'convenio'],
    professional: ['sou', 'me chamo', 'formado', 'formada', 'formação', 'profissional']
};

// Cria regex combinada para detecção de emprego
const createJobRegex = () => {
    const allTerms = [
        ...JOB_KEYWORDS.curriculum,
        ...JOB_KEYWORDS.job,
        ...JOB_KEYWORDS.search,
        ...JOB_KEYWORDS.action,
        ...JOB_KEYWORDS.partnership
    ];
    const escaped = allTerms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp('\\b(' + escaped.join('|') + ')\\b', 'i');
};

// Regex específica para "procura de profissional"
const JOB_SEARCH_REGEX = /\b(procura\s+(de\s+)?(profissional|terapeuta|fonoaudiólogo|psicólogo|fisioterapeuta)|estão\s+a\s+procura|precisa\s+(de\s+)?(fono|psicólogo|terapeuta)|tem\s+vaga\s+(para|de)|enviar\s+(curriculo|cv))\b/i;

// Regex para apresentação profissional + área
const PROFESSIONAL_INTRO_REGEX = /\b(sou|me\s+chamo)\b.*\b(fonoaudi[oó]log[oa]?|psic[oó]log[oa]?|terapeuta\s+ocupacional|fisioterapeuta|neuropsic[oó]log[oa]?|musicoterapeuta|psicopedagogo)\b/i;

// Helper para verificar se texto contém área específica
const containsArea = (text, area) => {
    if (!text || !THERAPY_KEYWORDS[area]) return false;
    const keywords = [...THERAPY_KEYWORDS[area].primary, ...THERAPY_KEYWORDS[area].related];
    const regex = createRegex(keywords);
    return regex.test(text.toLowerCase());
};

// Detecta todas as áreas mencionadas no texto
const detectAllAreas = (text) => {
    if (!text) return [];
    const detected = [];
    const lowerText = text.toLowerCase();
    
    for (const [area, keywords] of Object.entries(THERAPY_KEYWORDS)) {
        const allTerms = [...keywords.primary, ...keywords.related];
        const regex = createRegex(allTerms);
        if (regex.test(lowerText)) {
            detected.push(area);
        }
    }
    
    return detected;
};

// Detecta se é sobre emprego/currículo
const isJobRelated = (text) => {
    if (!text) return false;
    const lowerText = text.toLowerCase();
    
    if (JOB_SEARCH_REGEX.test(lowerText)) return true;
    if (PROFESSIONAL_INTRO_REGEX.test(lowerText)) return true;
    if (createJobRegex().test(lowerText)) return true;
    
    const hasProfessional = /\b(fonoaudi[oó]log|psic[oó]log|terapeuta|fisioterapeuta|neuropsic)\b/i.test(lowerText);
    const hasJobTerm = /\b(vaga|emprego|trabalho|curriculo|cv)\b/i.test(lowerText);
    
    return hasProfessional && hasJobTerm;
};

// Extrai área mencionada em contexto de emprego
const extractJobArea = (text) => {
    if (!text) return null;
    const areas = detectAllAreas(text);
    return areas.length > 0 ? areas[0] : null;
};

// Exporta tudo
export {
    THERAPY_KEYWORDS,
    JOB_KEYWORDS,
    AMBIGUOUS_TERMS,
    JOB_SEARCH_REGEX,
    PROFESSIONAL_INTRO_REGEX,
    createRegex,
    containsArea,
    detectAllAreas,
    isJobRelated,
    extractJobArea
};
