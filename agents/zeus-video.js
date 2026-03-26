/**
 * ZEUS v3.0 — Máquina de Aquisição de Pacientes
 *
 * Redesenhado para gerar comportamento, não conteúdo.
 * Cada roteiro move um lead de um estado psicológico → mensagem no WhatsApp.
 *
 * Mudanças v3.0 vs v2.0:
 * - Modelo: gpt-4o (substituindo gpt-4o-mini)
 * - 4 pipelines separados por estágio de jornada de compra
 * - Template obrigatório de 7 elementos orientados a conversão
 * - Campos novos: estagio_jornada, objecao_principal, crenca_a_quebrar, prova_social
 * - Score de CONVERSÃO substituindo score de conformidade
 * - CTA gerado conectado ao hook (não selecionado de pool genérico)
 * - Few-shot examples por pipeline (2 por tipo principal)
 * - Sem substituições de humanização via regex
 * - forcarIntencao corrigido (confianca forçada = 1.0)
 * - detectarIntencaoLead puramente informacional (não sobrescreve seleções do usuário)
 * - Instrução de intensidade moderada removida (bloqueava mecanismo de conversão)
 * - TONE_INSTRUCOES substituído por ESTADO_ALVO (estado emocional do viewer ao final)
 */

import OpenAI from 'openai';
import logger from '../utils/logger.js';
import {
  TEMPLATE_7_ELEMENTOS as TEMPLATE_DESCOBERTA_V2,
  FEW_SHOTS_DESCOBERTA_V2,
  scorarDescobertaV2,
} from './zeus-descoberta-config.js';

import {
  buildSystemPromptConsideracao,
  buildSystemPromptDecisao,
  buildSystemPromptRetargeting,
  FEW_SHOTS_CONSIDERACAO,
  FEW_SHOTS_DECISAO,
  FEW_SHOTS_RETARGETING,
  scorarConsideracao,
  scorarDecisao,
  scorarRetargeting,
} from './zeus-pipelines-complementares-config.js';

// Lazy initialization — evita erro de importação quando OPENAI_API_KEY não está definida (testes)
let _openai;
function getOpenAI() {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

const MODELO = 'gpt-4o';

// ─────────────────────────────────────────────
// SEÇÃO 1: MAPEAMENTOS BASE
// ─────────────────────────────────────────────

const ESPECIALIDADE_PROFISSIONAL = {
  fonoaudiologia:             'fono_ana',
  psicologia:                 'psico_bia',
  terapia_ocupacional:        'to_carla',
  terapiaocupacional:         'to_carla',
  neuropsicologia:            'neuro_dani',
  fisioterapia:               'fisio_edu',
  musicoterapia:              'musico_fer',
  atraso_fala:                'fono_ana',
  autismo:                    'psico_bia',
  comportamento:              'psico_bia',
  teste_linguinha:            'fono_ana',
  avaliacao_neuropsicologica: 'neuro_dani',
  coordenacao_motora:         'fisio_edu',
  fisioterapia_infantil:      'fisio_edu',
  psicomotricidade:           'to_carla',
  geral:                      'fono_ana',
};

const NOMES_PROFISSIONAL = {
  fono_ana:   'Ana (Fonoaudiologia)',
  psico_bia:  'Bia (Psicologia)',
  to_carla:   'Carla (Terapia Ocupacional)',
  neuro_dani: 'Dani (Neuropsicologia)',
  fisio_edu:  'Edu (Fisioterapia)',
  musico_fer: 'Fer (Musicoterapia)',
};

const HASHTAGS_BASE = {
  fonoaudiologia:             ['#Fonoaudiologia', '#FonoaudiologiaInfantil', '#DesenvolvimentoDaFala', '#FonoInova'],
  atraso_fala:                ['#AtrasoFala', '#FilhoNaoFala', '#DesenvolvimentoDaFala', '#Fonoaudiologia', '#FonoInova'],
  teste_linguinha:            ['#TesteDaLinguinha', '#FreioLingual', '#Fonoaudiologia', '#FonoInova'],
  psicologia:                 ['#PsicologiaInfantil', '#SaudeMentalInfantil', '#DesenvolvimentoInfantil', '#FonoInova'],
  autismo:                    ['#Autismo', '#TEA', '#AutismoInfantil', '#IdentificacaoPrecoce', '#FonoInova'],
  comportamento:              ['#ComportamentoInfantil', '#Birra', '#RegulacaoEmocional', '#PsicologiaInfantil', '#FonoInova'],
  terapia_ocupacional:        ['#TerapiaOcupacional', '#TOInfantil', '#DesenvolvimentoMotor', '#FonoInova'],
  terapiaocupacional:         ['#TerapiaOcupacional', '#TOInfantil', '#DesenvolvimentoMotor', '#FonoInova'],
  neuropsicologia:            ['#Neuropsicologia', '#AvaliacaoNeuropsicologica', '#TDAH', '#FonoInova'],
  avaliacao_neuropsicologica: ['#AvaliacaoNeuropsicologica', '#Neuropsicologia', '#TDAH', '#FonoInova'],
  fisioterapia:               ['#FisioterapiaInfantil', '#DesenvolvimentoMotor', '#FisioInfantil', '#FonoInova'],
  fisioterapia_infantil:      ['#FisioterapiaInfantil', '#DesenvolvimentoMotor', '#FisioInfantil', '#FonoInova'],
  coordenacao_motora:         ['#CoordenacaoMotora', '#DesenvolvimentoMotor', '#FisioterapiaInfantil', '#FonoInova'],
  psicomotricidade:           ['#Psicomotricidade', '#DesenvolvimentoMotor', '#TerapiaOcupacional', '#FonoInova'],
  musicoterapia:              ['#Musicoterapia', '#MusicoterapiaInfantil', '#FonoInova'],
  geral:                      ['#DesenvolvimentoInfantil', '#SaudeInfantil', '#FonoInova'],
};

const HASHTAGS_PUBLICO = ['#Maternidade', '#Parentalidade', '#DesenvolvimentoInfantil', '#CriancaSaudavel', '#MaeDePrimeiraViagem'];
const HASHTAGS_LOCAL   = ['#Anapolis', '#AnapolisGO', '#Goias'];

function montarHashtags(hashtagsGeradas = [], subTema, especialidade) {
  const chave = subTema || especialidade?.toLowerCase() || 'geral';
  const base  = HASHTAGS_BASE[chave] || HASHTAGS_BASE.geral;
  const normalizar = (h) => h.startsWith('#') ? h : `#${h}`;
  const todas = [...hashtagsGeradas.map(normalizar), ...base, ...HASHTAGS_PUBLICO, ...HASHTAGS_LOCAL];
  const vistas = new Set();
  return todas.filter(h => {
    const key = h.toLowerCase();
    if (vistas.has(key)) return false;
    vistas.add(key);
    return true;
  }).slice(0, 25);
}

// ─────────────────────────────────────────────
// SEÇÃO 2: DADOS DE CONVERSÃO POR SUBTEMA
// ─────────────────────────────────────────────

// Estado atual do pai, custo de não agir, e janela temporal por subTema
const PERFIL_SUBTEMA = {
  atraso_fala: {
    situacao_real:    'o filho tenta chamar, a palavra não sai, ou fala de forma que ninguém entende — e o pai finge que está tudo bem quando alguém pergunta',
    custo_invisivel:  'cada mês depois dos 3 anos, a plasticidade linguística cai — o que poderia ser resolvido em 6 meses hoje pode precisar de 2 anos amanhã',
    janela_temporal:  'antes dos 3 anos',
    crencas:          ['vai_melhorar_com_a_escola', 'e_timidez_nao_atraso', 'muito_novo_para_tratar', 'e_preguica_de_falar'],
    objecoes:         ['talvez_exagero', 'e_fase', 'muito_caro', 'marido_nao_acredita', 'ja_tentei'],
  },
  autismo: {
    situacao_real:    'a criança não olha nos olhos quando chamada, alinha objetos por horas, não brinca com outras crianças — e a família diz que é o "jeitinho dela"',
    custo_invisivel:  'diagnóstico antes dos 2 anos muda completamente o prognóstico — a janela de intervenção precoce tem início e fim',
    janela_temporal:  'antes dos 2 anos',
    crencas:          ['e_fase', 'vai_melhorar_na_escola', 'e_so_timidez', 'diagnostico_e_rotulo'],
    objecoes:         ['talvez_exagero', 'muito_caro', 'marido_nao_acredita', 'diagnostico_assusta', 'fica_longe'],
  },
  comportamento: {
    situacao_real:    'toda ida ao mercado pode virar crise, jantar é batalha, os limites não funcionam — e o pai já não sabe mais o que está fazendo errado',
    custo_invisivel:  'padrões de regulação emocional se consolidam nos primeiros anos — quanto mais tarde, mais resistente o padrão fica',
    janela_temporal:  'entre 2 e 6 anos',
    crencas:          ['e_fase', 'vai_passar_com_a_idade', 'e_frescura', 'precisa_ser_mais_firme'],
    objecoes:         ['talvez_exagero', 'muito_caro', 'marido_nao_acredita', 'ja_tentei_tudo'],
  },
  teste_linguinha: {
    situacao_real:    'amamentação dolorosa, bebê frustrado no peito, cliques ao mamar — e o pediatra disse que é normal',
    custo_invisivel:  'o freio lingual afeta amamentação, fala e deglutição — e quanto mais tarde é identificado, mais impacto tem no desenvolvimento',
    janela_temporal:  'nas primeiras semanas de vida',
    crencas:          ['e_normal_dor_na_amamentacao', 'vai_resolver_sozinho', 'pediatra_disse_que_esta_ok'],
    objecoes:         ['talvez_exagero', 'muito_caro', 'fica_longe', 'ja_consultei_e_disseram_que_nao'],
  },
  avaliacao_neuropsicologica: {
    situacao_real:    'criança não consegue se concentrar nas tarefas, esquece o que aprendeu, professora reclama toda semana — e o pai acha que é falta de força de vontade',
    custo_invisivel:  'sem diagnóstico, a criança acumula experiências de fracasso que afetam autoestima por anos — o problema escolar vira problema emocional',
    janela_temporal:  'antes do segundo ciclo escolar',
    crencas:          ['e_preguica', 'vai_melhorar_com_disciplina', 'e_so_falta_de_atencao', 'medicamento_resolve'],
    objecoes:         ['talvez_exagero', 'muito_caro', 'marido_nao_acredita', 'escola_nao_indicou'],
  },
  coordenacao_motora: {
    situacao_real:    'filho cai mais que os amigos, tem medo de brincar, não consegue andar de bicicleta na idade que os outros já andavam — e os outros pais comentam',
    custo_invisivel:  'dificuldades motoras não tratadas afetam autoestima, participação social e desempenho escolar',
    janela_temporal:  'entre 3 e 7 anos',
    crencas:          ['e_so_desajeitado', 'vai_melhorar_com_o_tempo', 'e_jeito_dele'],
    objecoes:         ['talvez_exagero', 'muito_caro', 'fica_longe'],
  },
  fisioterapia_infantil: {
    situacao_real:    'criança reclama de dor nas costas, anda de forma diferente, postura errada que o pediatra disse que é normal',
    custo_invisivel:  'padrões posturais e motores se consolidam na infância — corrigir depois é mais difícil e mais lento',
    janela_temporal:  'entre 4 e 10 anos',
    crencas:          ['vai_corrigir_sozinho', 'e_jeito_do_corpo', 'pediatra_disse_que_e_normal'],
    objecoes:         ['talvez_exagero', 'muito_caro', 'fica_longe'],
  },
  psicomotricidade: {
    situacao_real:    'criança confunde direita e esquerda, bate em tudo, não consegue andar de bicicleta — os colegas percebem e ela começa a se isolar',
    custo_invisivel:  'dificuldades psicomotoras afetam aprendizagem, escrita e autoestima',
    janela_temporal:  'entre 4 e 8 anos',
    crencas:          ['e_desajeitado_natural', 'vai_melhorar_com_esporte', 'e_so_fase'],
    objecoes:         ['talvez_exagero', 'muito_caro', 'fica_longe'],
  },
};

// Tratamento de cada objeção — nomeação + desmonte específico
const TRATAMENTO_OBJECAO = {
  talvez_exagero: {
    nomeacao:   'talvez você esteja exagerando — é o que a maioria pensa antes de vir aqui',
    desmonte:   'prefiro avaliar e confirmar que está tudo bem do que você esperar mais seis meses e chegar com um atraso maior do que o de hoje',
    angulo:     'permissão para buscar ajuda sem se sentir exagerada',
  },
  e_fase: {
    nomeacao:   '"deve ser fase" — essa é a frase mais cara que uma família pode ouvir',
    desmonte:   'em anos de clínica, os casos que melhoraram sozinhos dá pra contar nos dedos de uma mão — os outros chegaram mais tarde e levaram o dobro do tempo',
    angulo:     'custo real da espera baseado em experiência clínica',
  },
  muito_caro: {
    nomeacao:   'o custo da avaliação pesa quando você não sabe o que vai encontrar',
    desmonte:   'o que uma família investe em avaliação precoce economiza em anos de terapia depois — e a janela que fecha agora não reabre no mesmo ponto',
    angulo:     'custo de oportunidade, não custo do serviço',
  },
  marido_nao_acredita: {
    nomeacao:   '"meu marido acha que estou exagerando" — ouço isso toda semana',
    desmonte:   'toda semana atendo crianças cujo pai dizia que era exagero da mãe — e quando chegam, eles são os primeiros a agradecer por não ter esperado mais',
    angulo:     'validação da intuição materna com prova de experiência clínica',
  },
  ja_tentei: {
    nomeacao:   'você já tentou outras abordagens e não funcionou — faz sentido ter dúvida',
    desmonte:   'o que não funcionou antes pode não ter sido a abordagem certa para o que seu filho tem especificamente — avaliação individualizada muda o direcionamento',
    angulo:     'especificidade da abordagem vs. tentativas genéricas anteriores',
  },
  diagnostico_assusta: {
    nomeacao:   'você tem medo do que vai descobrir — e isso paralisa muita gente',
    desmonte:   'o diagnóstico não cria o problema — ele nomeia o que já existe e abre o caminho para resolver — sem ele, você trata no escuro',
    angulo:     'diagnóstico como libertação, não como sentença',
  },
  fica_longe: {
    nomeacao:   'a distância é real e o deslocamento pesa',
    desmonte:   'a maioria das famílias que atendo vem de outras cidades — e quando pergunto se valeu, a resposta é sempre a mesma',
    angulo:     'valor percebido vs. custo de deslocamento',
  },
  ja_consultei_e_disseram_que_nao: {
    nomeacao:   'você já consultou e disseram que estava tudo bem',
    desmonte:   'avaliações diferentes podem chegar a conclusões diferentes dependendo da metodologia — uma segunda opinião especializada custa menos do que descobrir tarde',
    angulo:     'segunda opinião como proteção, não como desconfiança',
  },
};

// Cenas de abertura por subTema — observacionais, sem drama, pai se reconhece antes de entender
// Tom: acolhedor — a cena é do dia a dia, não uma tragédia
const CENAS_ABERTURA = {
  atraso_fala: [
    'Fim de tarde. Ele tentou me chamar. A palavra saiu diferente.',
    'Ele aponta pro biscoito. A palavra não veio. Ele aponta de novo.',
    'Ela sabia o que queria dizer. A palavra não saía. Ela desistia e mostrava com o dedo.',
    'Você chamou o nome dele. Ele continuou brincando. Você chamou de novo.',
  ],
  autismo: [
    'Ela brincava sozinha enquanto as outras crianças corriam juntas. Você olhava de longe.',
    'Você chamou o nome dele três vezes. Na terceira ele olhou — mas não pra você.',
    'Na festa, as crianças brincavam juntas. Ele ficou perto dos blocos. Sozinho, mas concentrado.',
  ],
  comportamento: [
    'O jantar ficou tenso de novo. Ela tentou tudo. Nada funcionou.',
    'No mercado, ele pediu biscoito. Ela disse não. A situação saiu do controle.',
    'Ele sente tudo muito forte. Qualquer coisa pequena vira uma crise grande.',
  ],
  teste_linguinha: [
    'Quinto dia tentando amamentar. O bebê largava o peito. Ela não entendia por quê.',
    'O bebê fazia clique toda vez que mamava. O pediatra disse que era normal.',
    'Ela achava que era ela que estava fazendo errado. Não era.',
  ],
  avaliacao_neuropsicologica: [
    'A professora ligou de novo. "Ele não consegue terminar as atividades."',
    'Ela estudou por duas horas. Na prova, não lembrava o que tinha lido.',
    'Toda noite tem choro pra fazer tarefa. Ela já não sabe mais como ajudar.',
  ],
  coordenacao_motora: [
    'Ele ficou de fora da brincadeira. Tinha medo de cair de novo.',
    'Ela tem seis anos e ainda não consegue andar de bicicleta. Os amigos já conseguem.',
    'Você percebeu que ele cai mais que as outras crianças — mas não sabe se é normal.',
  ],
  fisioterapia_infantil: [
    'Ela reclama de dor nas costas. Tem oito anos.',
    'O pediatra disse que a postura dele era normal. Mas você continua observando.',
  ],
  psicomotricidade: [
    'Na aula de natação, a professora disse que ela confundia os lados mais do que o esperado.',
    'Ele tropeça mais do que os amigos. Todo dia. Você já não sabe se é jeito ou algo a mais.',
  ],
};

function escolherCena(subTema, seed = 0) {
  const lista = CENAS_ABERTURA[subTema] || CENAS_ABERTURA.atraso_fala;
  return lista[Math.floor(seed * lista.length) % lista.length];
}

// ─────────────────────────────────────────────
// SEÇÃO 3: MAPEAMENTO DE ESTADO POR JORNADA
// ─────────────────────────────────────────────

const MAPEAMENTO_JORNADA = {
  descoberta: {
    estado_atual:    'sabe que algo pode estar errado, mas ainda não agiu — pode estar em negação, minimizando, ou esperando "pra ver"',
    estado_desejado: 'desconforto cognitivo suficiente para não conseguir mais ignorar — "não posso continuar fingindo que está tudo bem"',
    mecanismo:       'cena de reconhecimento + custo invisível da inação + janela de desenvolvimento que fecha',
    cta_tipo:        'micro_comprometimento',
    cta_destino:     'comentar, salvar, seguir — NUNCA WhatsApp direto',
    proibicoes:      ['cta_whatsapp_direto', 'cta_agendar'],
  },
  consideracao: {
    estado_atual:    'sabe que precisa de ajuda, está avaliando se essa clínica especificamente é a certa — tem dúvida sobre competência, abordagem, ou resultado',
    estado_desejado: 'convicção de que essa clínica entende o problema do filho de forma que os outros não entenderam — confiança específica, não genérica',
    mecanismo:       'autoridade demonstrada por caso específico + diferenciação implícita + prova social concreta',
    cta_tipo:        'qualificacao',
    cta_destino:     'WhatsApp com baixa fricção para qualificar — "manda mensagem e eu te digo se o que você descreveu é algo que tratamos"',
    proibicoes:      ['educacao_generica', 'cta_educacional'],
  },
  decisao: {
    estado_atual:    'já decidiu que precisa de ajuda, tem uma objeção específica bloqueando a ação — preço, distância, medo do diagnóstico, cônjuge que não acredita',
    estado_desejado: 'objeção removida + próximo passo com fricção zero — "não existe mais razão válida para não fazer isso agora"',
    mecanismo:       'nomeação direta da objeção + desmonte com especificidade + próximo passo mínimo + friction eliminator',
    cta_tipo:        'acao_direta',
    cta_destino:     'WhatsApp com palavra-chave específica + eliminador de fricção ("primeira conversa sem compromisso", "respondo hoje")',
    proibicoes:      ['educacao_generica', 'cta_fraco'],
  },
  retargeting: {
    estado_atual:    'já foi exposta ao conteúdo, sentiu algo, não agiu — está represada, não fria; a intenção existe mas está bloqueada por inércia ou medo',
    estado_desejado: 'reativação da intenção existente — "eu já sabia disso, o que estou esperando"',
    mecanismo:       'referência implícita ao conhecimento compartilhado + tempo que passou com consequência real + próximo passo mínimo absoluto',
    cta_tipo:        'reativacao',
    cta_destino:     'passo mínimo possível — "manda só um oi" — sem reexplicar nada',
    proibicoes:      ['educacao_nova', 'venda_direta'],
  },
};

// ─────────────────────────────────────────────
// SEÇÃO 4: FEW-SHOT EXAMPLES (2 por pipeline)
// ─────────────────────────────────────────────
// Usando few-shots otimizados dos arquivos de configuração

const FEW_SHOT = {
  // descoberta: importado de zeus-descoberta-config.js
  descoberta: FEW_SHOTS_DESCOBERTA_V2.map(ex => ({
    params: `subTema=${ex.tema} | estagio=descoberta`,
    output: {
      titulo: ex.elementos.titulo || ex.tema,
      texto_completo: ex.texto_completo,
      hook_texto_overlay: ex.elementos.cena_inicial || ex.elementos.hook_texto_overlay,
      cta_texto_overlay: ex.elementos.cta,
    },
  })),
  
  // consideracao: importado de zeus-pipelines-complementares-config.js
  consideracao: FEW_SHOTS_CONSIDERACAO.map(ex => ({
    params: `subTema=${ex.tema} | estagio=consideracao`,
    output: {
      titulo: ex.elementos.titulo || ex.tema,
      texto_completo: ex.texto_completo,
      hook_texto_overlay: ex.elementos.cena_inicial,
      cta_texto_overlay: ex.elementos.cta,
    },
  })),
  
  // decisao: importado de zeus-pipelines-complementares-config.js
  decisao: FEW_SHOTS_DECISAO.map(ex => ({
    params: `subTema=${ex.tema} | estagio=decisao | objecao=${ex.objecao || 'e_fase'}`,
    output: {
      titulo: ex.elementos.titulo || ex.tema,
      texto_completo: ex.texto_completo,
      hook_texto_overlay: ex.elementos.cena_inicial,
      cta_texto_overlay: ex.elementos.cta,
    },
  })),
  
  // retargeting: importado de zeus-pipelines-complementares-config.js
  retargeting: FEW_SHOTS_RETARGETING.map(ex => ({
    params: `subTema=${ex.tema} | estagio=retargeting`,
    output: {
      titulo: ex.elementos.titulo || ex.tema,
      texto_completo: ex.texto_completo,
      hook_texto_overlay: ex.elementos.cena_inicial,
      cta_texto_overlay: ex.elementos.cta,
    },
  })),
};



// ─────────────────────────────────────────────
// SEÇÃO 5: PIPELINE SYSTEM PROMPTS (4 distintos)
// ─────────────────────────────────────────────

// Tom específico por estágio — define o estado emocional que o viewer deve ter ao final
const TOM_POR_ESTAGIO = {
  descoberta: `
TOM OBRIGATÓRIO PARA DESCOBERTA: ACOLHEDOR E VALIDANTE
- O pai deve terminar o vídeo sentindo: "alguém entende o que estou vivendo"
- NUNCA culpa, NUNCA urgência exagerada, NUNCA drama
- Voz de especialista confiável falando diretamente, como numa conversa
- Valide a dúvida antes de qualquer informação: "faz sentido você estar se perguntando isso"
- A tensão é curiosidade suave, não medo — "existe algo que vale prestar atenção"
- A janela temporal aparece como informação, não como ameaça
- CTA: micro-comprometimento natural ("salva", "comenta") — NUNCA WhatsApp ou agendamento
- PROIBIDO: "você precisa agir agora", "não espere mais", "está perdendo tempo"
- PROIBIDO: cenas de choro, desespero, vergonha pública
- PERMITIDO: cenas de observação silenciosa, dúvida genuína, dia a dia normal`,

  consideracao: `
TOM OBRIGATÓRIO PARA CONSIDERAÇÃO: AUTORIDADE EMPÁTICA
- O pai deve terminar sentindo: "essa clínica entende o que meu filho tem de forma diferente"
- Demonstre competência através de casos e resultados, não através de credenciais
- Tom direto mas humanizado — não é palestra, é conversa de especialista`,

  decisao: `
TOM OBRIGATÓRIO PARA DECISÃO: DIRETO E DESBLOQUEADOR
- O pai deve terminar sentindo: "não existe mais razão válida para não fazer isso agora"
- Nomeie a objeção sem rodeio, desmonte com especificidade
- Tom firme mas não agressivo — como um amigo especialista que fala a verdade`,

  retargeting: `
TOM OBRIGATÓRIO PARA RETARGETING: CUMPLICIDADE TRANQUILA
- O pai deve terminar sentindo: "já sabia disso — o próximo passo é menor do que penso"
- NUNCA julgamento pela demora — remoção de culpa, abertura do caminho
- Tom de continuidade, como retomada de conversa já iniciada`,
};

function buildSystemPrompt(estagio, mapeamento, fewShots) {
  // Usar templates otimizados por estágio
  if (estagio === 'descoberta') {
    return buildSystemPromptDescobertaV2(mapeamento);
  }
  if (estagio === 'consideracao') {
    return buildSystemPromptConsideracao(mapeamento);
  }
  if (estagio === 'decisao') {
    return buildSystemPromptDecisao(mapeamento);
  }
  if (estagio === 'retargeting') {
    return buildSystemPromptRetargeting(mapeamento);
  }

  const exemplosStr = fewShots.map((ex, i) =>
    `EXEMPLO ${i + 1} (${ex.params}):\n${JSON.stringify(ex.output, null, 2)}`
  ).join('\n\n');

  const tomEstagio = TOM_POR_ESTAGIO[estagio] || '';

  const base = `Você é ZEUS, especialista em conteúdo de aquisição para clínicas de saúde infantil (Fono Inova — Anápolis/GO).
Atende: Fonoaudiologia, Psicologia Infantil, Terapia Ocupacional, Fisioterapia, Psicomotricidade, Avaliação Neuropsicológica, Musicoterapia, Teste da Linguinha.
Público: pais de crianças de 0 a 10 anos.

OBJETIVO DESTE PIPELINE: ${estagio.toUpperCase()}
Estado atual do viewer: ${mapeamento.estado_atual}
Estado desejado ao final: ${mapeamento.estado_desejado}
Mecanismo de transição: ${mapeamento.mecanismo}
CTA permitido: ${mapeamento.cta_destino}
Proibições: ${mapeamento.proibicoes.join(', ')}
${tomEstagio}

TEMPLATE OBRIGATÓRIO — 7 ELEMENTOS NESSA ORDEM:

1. CENA INICIAL (0-2s)
   - Local específico + momento do dia + ação concreta da criança ou do pai
   - ZERO explicação, ZERO contexto, ZERO pergunta
   - O pai se reconhece na cena antes de entender por quê
   - Use a cena fornecida em hook_texto_overlay EXATAMENTE

2. HOOK DE TENSÃO (2-5s)
   - Afirmação que cria incompletude cognitiva
   - NUNCA pergunta — perguntas criam verificação, não tensão
   - Implica que o pai está perdendo algo ou que existe algo que ele não sabe
   - Não resolve a tensão — a mantém aberta

3. AMPLIFICAÇÃO EMOCIONAL (5-12s)
   - Aprofunda a tensão sem resolver
   - Dois níveis: custo de desenvolvimento (janela que fecha) + custo de identidade (pai que sabia e não agiu)
   - Específico, não genérico — números ou comportamentos concretos

4. QUEBRA DE CRENÇA (12-18s)
   - Desmonta a crença específica que mantém inação
   - Com dado clínico ou observação de experiência real — nunca argumento abstrato
   - "Em anos de clínica..." ou dado de desenvolvimento concreto

5. PROVA (18-22s)
   - Resultado recente, caso específico ou volume com contexto
   - NUNCA: "já ajudei muitas famílias", "temos ótimos resultados"
   - SIM: número, tempo, situação específica reconhecível

6. TRATAMENTO DE OBJEÇÃO (22-26s)
   - Uma objeção. A principal. Nomeada sem rodeio.
   - Desmontada com especificidade — não com argumento genérico

7. CTA NO PICO EMOCIONAL (26-30s)
   - Gerado como resolução direta da tensão criada no elemento 2
   - CTA fecha o loop aberto do hook — o viewer sente que é continuação natural, não venda
   - Ação específica + friction eliminator
   - TIPO PERMITIDO PARA ESTE ESTÁGIO: ${mapeamento.cta_tipo}

REGRAS GLOBAIS:
- Linguagem falada, frases máximo 12 palavras, contrações naturais (tá, às vezes, a gente)
- PROIBIDO: jargão clínico pesado, frases genéricas ("é muito importante", "devemos observar")
- PROIBIDO: afirmar diagnóstico — usar "pode indicar", "vale avaliar", "estou vendo"
- Compliance saúde: nunca garantir resultado, nunca afirmar diagnóstico
- Retorne APENAS o JSON solicitado, sem markdown, sem texto extra

EXEMPLOS DE REFERÊNCIA (estude a estrutura, não copie):
${exemplosStr}`;

  return base;
}

// Template otimizado v2 para pipeline de descoberta
function buildSystemPromptDescobertaV2(mapeamento) {
  const exemplosStr = FEW_SHOTS_DESCOBERTA_V2.map((ex, i) => `
EXEMPLO ${i + 1} — ${ex.tema} (${ex.palavras} palavras):
${ex.texto_completo}

Elementos:
- Cena: ${ex.elementos.cena_inicial}
- Hook: ${ex.elementos.hook_tensao}
- Prova: ${ex.elementos.prova_concreta}
- CTA: ${ex.elementos.cta}
`).join('\n---\n');

  return `Você é ZEUS, especialista em conteúdo de aquisição para clínicas de saúde infantil (Fono Inova — Anápolis/GO).

${TEMPLATE_DESCOBERTA_V2}

TOM OBRIGATÓRIO: ACOLHEDOR E CONFIÁVEL
- Sem culpa, sem drama, sem urgência exagerada
- Voz de especialista que entende e acolhe
- Frases curtas (máx 12 palavras), linguagem falada
- Use "a gente", "você", contrações naturais (tá, às vezes, tô)
- Valide antes de informar: "Faz sentido você pensar assim"

ESTADO DO VIEWER:
- Atual: ${mapeamento.estado_atual}
- Desejado: ${mapeamento.estado_desejado}
- Mecanismo: ${mapeamento.mecanismo}

PROIBIDO:
- Perguntas no hook (evite: "Você sabia que...?", "Já percebeu que...?")
- Urgência agressiva: "não espere mais", "cada dia que passa", "está perdendo tempo"
- CTA de WhatsApp, agendamento, "entre em contato"
- Prova vaga: "muitas crianças", "vários casos", "ótimos resultados"
- Linguagem culposa: "você está errando", "deveria"

METAS RIGOROSAS:
- Mínimo 80 palavras (contar no texto_completo)
- Prova concreta com número, % ou caso específico obrigatória
- CTA de micro-comprometimento apenas (salva, comenta, compartilha)

${exemplosStr}

Retorne APENAS JSON:
{
  "roteiro": {
    "titulo": "... (máx 50 chars)",
    "texto_completo": "... (mínimo 80 palavras, máximo 95)",
    "hook_texto_overlay": "... (cena específica, 0-2s)",
    "cta_texto_overlay": "... (micro-comprometimento, sem WhatsApp)",
    "prova_concreta_usada": "... (qual número/resultado usou)",
    "contagem_palavras": 0
  }
}`;
}

// ─────────────────────────────────────────────
// SEÇÃO 6: SCORE DE CONVERSÃO
// ─────────────────────────────────────────────

function scorarConversao(roteiro, params) {
  const { estagio_jornada, objecao_principal } = params;

  // Usar scores otimizados por estágio
  if (estagio_jornada === 'descoberta') {
    return scorarDescobertaV2(roteiro, params);
  }
  if (estagio_jornada === 'consideracao') {
    return scorarConsideracao(roteiro, params);
  }
  if (estagio_jornada === 'decisao') {
    return scorarDecisao(roteiro, params);
  }
  if (estagio_jornada === 'retargeting') {
    return scorarRetargeting(roteiro, params);
  }
  const t    = roteiro.texto_completo || '';
  const tLow = t.toLowerCase();
  const hook = (roteiro.hook_texto_overlay || '').toLowerCase();
  const cta  = (roteiro.cta_texto_overlay  || '').toLowerCase();

  let score = 100;
  const falhas = [];

  // -30: CTA de WhatsApp direto em roteiro de descoberta
  if (estagio_jornada === 'descoberta') {
    const ctaWhats = ['whatsapp', 'manda mensagem', 'chama aqui', 'agende', 'marcar'];
    if (ctaWhats.some(c => cta.includes(c))) {
      score -= 30;
      falhas.push('CTA de WhatsApp em descoberta — mata lead frio antes de construir confiança');
    }
  }

  // -25: sem tratamento de objeção em consideracao/decisao
  if (['consideracao', 'decisao'].includes(estagio_jornada) && objecao_principal) {
    const palavrasObjecao = objecao_principal.replace(/_/g, ' ').split('_');
    const temObjecao = palavrasObjecao.some(p => tLow.includes(p)) ||
      tLow.includes('fase') || tLow.includes('caro') || tLow.includes('exager') ||
      tLow.includes('marido') || tLow.includes('tentei') || tLow.includes('distanc');
    if (!temObjecao) {
      score -= 25;
      falhas.push('Objeção principal não tratada — bloqueio pré-ação permanece ativo');
    }
  }

  // -20: hook é pergunta (mecanismo de stop-scroll mais fraco)
  if (hook.endsWith('?') || hook.includes('você sabia que') || hook.includes('já percebeu')) {
    score -= 20;
    falhas.push('Hook é pergunta — cria verificação ("tenho/não tenho") em vez de tensão universal');
  }

  // -20: sem janela temporal (urgência baseada em desenvolvimento)
  const temJanela = /\d+\s*(anos?|meses?|semanas?|ciclo)/.test(tLow) ||
    tLow.includes('antes dos') || tLow.includes('janela') || tLow.includes('plasticidade');
  if (!temJanela) {
    score -= 20;
    falhas.push('Sem janela temporal — sem urgência real baseada em desenvolvimento');
  }

  // -15: sem cena específica no início (sem stop-scroll real)
  const temCena = roteiro.hook_texto_overlay && roteiro.hook_texto_overlay.length > 0 &&
    !roteiro.hook_texto_overlay.toLowerCase().startsWith('você sabia') &&
    !roteiro.hook_texto_overlay.toLowerCase().startsWith('preste');
  if (!temCena) {
    score -= 15;
    falhas.push('Sem cena de abertura — sem stop-scroll real');
  }

  // -15: sem prova concreta
  const temProva = /\d+\s*(palavras?|crianças?|famílias?|meses?|semanas?|anos?)/.test(tLow) ||
    tLow.includes('semana passada') || tLow.includes('esse mês') || tLow.includes('ontem') ||
    tLow.includes('atendi') && /\d/.test(tLow);
  if (!temProva) {
    score -= 15;
    falhas.push('Sem prova concreta — afirmação de autoridade sem evidência');
  }

  // -10: CTA fraco ou genérico
  const ctaFraco = ['quando quiser', 'se fizer sentido', 'não hesite', 'agende agora', 'não perca'];
  if (ctaFraco.some(c => cta.includes(c))) {
    score -= 10;
    falhas.push('CTA fraco — transfere decisão para o viewer sem criar urgência');
  }

  // -10: texto muito curto para criar arco completo
  const palavras = t.split(/\s+/).filter(Boolean).length;
  if (palavras < 70) {
    score -= 10;
    falhas.push('Texto curto demais para os 7 elementos');
  }

  return { score: Math.max(score, 0), falhas };
}

// ─────────────────────────────────────────────
// SEÇÃO 7: FUNÇÃO PRINCIPAL gerarRoteiro()
// ─────────────────────────────────────────────

/**
 * Gera roteiro orientado a conversão (ZEUS v3.0)
 *
 * @param {object} params
 *
 * Campos v3.0 (novos — orientados a conversão):
 * @param {string} params.estagio_jornada     - descoberta | consideracao | decisao | retargeting
 * @param {string} params.objecao_principal   - e_fase | muito_caro | talvez_exagero | marido_nao_acredita | ja_tentei | diagnostico_assusta | fica_longe
 * @param {string} params.crenca_a_quebrar    - crença específica que mantém inação (auto-detectada se omitida)
 * @param {string} params.prova_social        - resultado recente, caso ou volume para incluir
 * @param {string} params.janela_temporal     - urgência temporal (auto-detectada por subTema se omitida)
 * @param {string} params.tipo_conteudo       - aquisicao_organica | conversao_direta
 *
 * Campos v2.0 (mantidos para compatibilidade):
 * @param {string} params.subTema             - atraso_fala | autismo | comportamento | etc.
 * @param {string} params.especialidade       - fallback se subTema não fornecido
 * @param {number} params.duracao             - duração em segundos (default 30)
 * @param {string} params.platform            - instagram | meta_ads
 * @param {string} params.hookStyle           - dor | curiosidade | alerta | autoridade | erro_comum (informacional em v3.0)
 * @param {number} params.variacao            - 0..1 para anti-repetição
 * @param {string} params.bordao              - bordão obrigatório de abertura
 * @param {string} params.contextoLead        - texto do lead para enriquecer contexto (informacional)
 * @param {string} params.forcarIntencao      - forçar intenção específica (corrigido em v3.0)
 */
export async function gerarRoteiro({
  // v3.0
  estagio_jornada   = 'descoberta',
  objecao_principal = null,
  crenca_a_quebrar  = null,
  prova_social      = null,
  janela_temporal   = null,
  tipo_conteudo     = 'aquisicao_organica',
  prompt_extra      = null,  // Instruções adicionais do usuário

  // v2.0 (compatibilidade — alguns campos são aceitos mas não usados internamente)
  tema:       _tema,
  especialidade,
  funil             = 'TOPO',
  duracao           = 30,
  tone:       _tone,
  platform          = 'instagram',
  subTema,
  hookStyle:  _hookStyle,
  objetivo:   _objetivo,
  variacao          = Math.random(),
  intensidade: _intensidade,
  bordao            = '',
  contextoLead      = null,
  forcarIntencao    = null,
} = {}) {

  // ── Mapear funil v2.0 → estagio_jornada v3.0 (compatibilidade)
  if (funil && estagio_jornada === 'descoberta') {
    const mapaFunil = { TOPO: 'descoberta', MEIO: 'consideracao', FUNDO: 'decisao' };
    if (mapaFunil[funil]) estagio_jornada = mapaFunil[funil];
  }

  // ── Detecção de intenção — informacional apenas, não sobrescreve seleções
  let intencaoInfo = null;
  if (forcarIntencao) {
    intencaoInfo = { intencao: forcarIntencao, confianca: 1.0, origem: 'forcado' };
    logger.info(`[ZEUS] Intenção forçada: ${forcarIntencao}`);
  } else if (contextoLead) {
    intencaoInfo = detectarIntencaoLead(contextoLead);
    logger.info(`[ZEUS] Intenção detectada (informacional): ${intencaoInfo.intencao} (${(intencaoInfo.confianca * 100).toFixed(0)}%)`);
  }

  // ── Dados do subTema
  const perfil        = PERFIL_SUBTEMA[subTema] || PERFIL_SUBTEMA.atraso_fala;
  const profissional  = ESPECIALIDADE_PROFISSIONAL[subTema] ||
                        ESPECIALIDADE_PROFISSIONAL[especialidade?.toLowerCase()] ||
                        'fono_ana';
  const nomeProfissional = NOMES_PROFISSIONAL[profissional];

  // ── Auto-detectar campos omitidos
  const objecaoFinal   = objecao_principal || perfil.objecoes[0] || 'e_fase';
  const crencaFinal    = crenca_a_quebrar  || perfil.crencas[0]  || 'e_fase';
  const janelaFinal    = janela_temporal   || perfil.janela_temporal || 'antes dos 3 anos';
  const tratObjecao    = TRATAMENTO_OBJECAO[objecaoFinal] || TRATAMENTO_OBJECAO.talvez_exagero;
  const cenaInicial    = escolherCena(subTema, variacao);
  const mapeamento     = MAPEAMENTO_JORNADA[estagio_jornada] || MAPEAMENTO_JORNADA.descoberta;
  const fewShots       = FEW_SHOT[estagio_jornada] || FEW_SHOT.descoberta;

  // ── Duração efetiva
  const duracaoEfetiva = platform === 'instagram'
    ? Math.min(Math.max(duracao, 20), 35)
    : Math.min(Math.max(duracao, 30), 60);

  // ── System prompt do pipeline
  const systemPrompt = buildSystemPrompt(estagio_jornada, mapeamento, fewShots);

  // ── User prompt com todos os dados de conversão
  const userPrompt = `SubTema: ${subTema || especialidade || 'geral'}
Profissional: ${nomeProfissional}
Estágio de jornada: ${estagio_jornada}
Plataforma: ${platform}
Duração alvo: ${duracaoEfetiva}s (~${Math.floor(duracaoEfetiva * 2.2)} palavras na narração)
Tipo de conteúdo: ${tipo_conteudo}

PERFIL DO VIEWER NESTE MOMENTO:
Situação real: ${perfil.situacao_real}
Custo invisível de não agir: ${perfil.custo_invisivel}

JANELA TEMPORAL (mencionar no roteiro):
${janelaFinal}

CRENÇA A QUEBRAR:
${crencaFinal.replace(/_/g, ' ')}

OBJEÇÃO PRINCIPAL A TRATAR:
Nomeação: ${tratObjecao.nomeacao}
Desmonte: ${tratObjecao.desmonte}
Ângulo: ${tratObjecao.angulo}

PROVA SOCIAL (incluir se disponível):
${prova_social || 'Gere prova baseada em experiência clínica realista e específica — número, tempo ou caso. Nunca genérico.'}

CENA DE ABERTURA (usar EXATAMENTE como hook_texto_overlay):
"${cenaInicial}"

${bordao ? `BORDÃO OBRIGATÓRIO DE ABERTURA (primeira palavra falada):
"${bordao}"
O hook_texto_overlay também deve começar com "${bordao}"` : ''}

${contextoLead ? `CONTEXTO DO LEAD (enriquecer a especificidade do roteiro):
${contextoLead}` : ''}

${intencaoInfo ? `INTENÇÃO DO LEAD DETECTADA (informacional — use para personalizar):
Intenção: ${intencaoInfo.intencao} (confiança: ${(intencaoInfo.confianca * 100).toFixed(0)}%)` : ''}

${prompt_extra ? `INSTRUÇÕES ADICIONAIS DO USUÁRIO (seguir rigorosamente):
${prompt_extra}` : ''}

Retorne JSON:
{
  "roteiro": {
    "titulo": "título em português, máx 50 chars, descritivo",
    "profissional": "${profissional}",
    "duracao_estimada": ${duracaoEfetiva},
    "estagio_jornada": "${estagio_jornada}",
    "texto_completo": "narração exata que o avatar vai falar — linguagem falada, frases curtas, tom de conversa",
    "hook_texto_overlay": "USAR EXATAMENTE: ${cenaInicial}",
    "cta_texto_overlay": "CTA gerado como resolução da tensão do hook — conectado, específico, com friction eliminator — tipo: ${mapeamento.cta_tipo}",
    "legenda_instagram": "primeiros 125 chars contêm a keyword principal. Quebras de linha. Máx 3 emojis. Mínimo 150 chars total.",
    "hashtags": ["8 a 10 hashtags específicas do tema — sem localidade e sem #FonoInova que são adicionadas automaticamente"],
    "copy_anuncio": {
      "texto_primario": "2-3 linhas para Meta Ads",
      "headline": "5-8 palavras",
      "descricao": "1 frase"
    },
    "storyboard_hint": "O texto_completo deve ser dividido em frases curtas (2-8 palavras cada) separadas por pontos finais, facilitando a direção de cena automática"
  }
}`;

  const MAX_TENTATIVAS = 3;
  let ultimoErro;

  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS; tentativa++) {
    if (tentativa > 1) {
      logger.info(`[ZEUS] Tentativa ${tentativa}/${MAX_TENTATIVAS} — reprovado: ${ultimoErro}`);
    }

    try {
      const temperature = 0.9 + (tentativa - 1) * 0.05;

      const response = await getOpenAI().chat.completions.create({
        model: MODELO,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userPrompt   },
        ],
        temperature,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
      });

      const resultado = JSON.parse(response.choices[0].message.content);

      if (!resultado.roteiro?.texto_completo) {
        throw new Error('ZEUS retornou roteiro sem texto_completo');
      }

      // ── Score de conversão
      const { score, falhas } = scorarConversao(resultado.roteiro, {
        estagio_jornada,
        objecao_principal: objecaoFinal,
      });

      logger.info(`[ZEUS] Score de conversão: ${score}/100${falhas.length ? ` | Falhas: ${falhas.join(' | ')}` : ''}`);

      if (score < 55 && tentativa < MAX_TENTATIVAS) {
        ultimoErro = `Score ${score}/100 — ${falhas[0]}`;
        throw new Error(ultimoErro);
      }

      if (falhas.length > 0) {
        logger.warn(`[ZEUS] Avisos de conversão: ${falhas.join(' | ')}`);
      }

      // ── Montar hashtags
      resultado.roteiro.hashtags = montarHashtags(
        resultado.roteiro.hashtags || [],
        subTema,
        especialidade,
      );

      // ── Metadados
      resultado.roteiro._meta = {
        modelo:            MODELO,
        estagio_jornada,
        objecao_tratada:   objecaoFinal,
        crenca_quebrada:   crencaFinal,
        janela_temporal:   janelaFinal,
        score_conversao:   score,
        tentativa,
        intencao_lead:     intencaoInfo?.intencao || null,
      };

      const palavras = resultado.roteiro.texto_completo.split(/\s+/).length;
      logger.info(`[ZEUS] Roteiro gerado: ${palavras} palavras | estágio=${estagio_jornada} | score=${score} | ${nomeProfissional}`);

      // ── Gerar storyboard automático (Zeus v3.3)
      resultado.roteiro.storyboard = gerarStoryboard(resultado.roteiro, estagio_jornada, perfil);
      
      // ── Gerar prompt Veo pronto
      resultado.roteiro.veo_prompt = gerarPromptVeo(resultado.roteiro.storyboard, estagio_jornada);

      return resultado;

    } catch (error) {
      const rejeicaoQualidade = error.message.startsWith('Score') ||
                                error.message.startsWith('ZEUS retornou');

      if (rejeicaoQualidade && tentativa < MAX_TENTATIVAS) {
        ultimoErro = error.message;
        continue;
      }

      logger.error('[ZEUS] Erro ao gerar roteiro:', error.message);
      throw error;
    }
  }

  throw new Error(`[ZEUS] Roteiro reprovado após ${MAX_TENTATIVAS} tentativas: ${ultimoErro}`);
}

// ─────────────────────────────────────────────
// SEÇÃO 8: detectarIntencaoLead() — INFORMACIONAL
// Não sobrescreve seleções do usuário.
// Retorna dados para enriquecer contexto apenas.
// ─────────────────────────────────────────────

const INTENCAO_KEYWORDS = {
  duvida: [
    'não sei se', 'será que', 'acho que', 'dúvida', 'como funciona',
    'o que é', 'por que', 'como sabe', 'não entendo', 'me explica',
  ],
  preocupacao: [
    'preocupada', 'preocupado', 'medo', 'angustiada', 'desesperada',
    'desesperado', 'não sei o que fazer', 'tô perdida', 'tô perdido',
    'será que é grave', 'pode ser autismo', 'pode ser atraso', 'tem algo errado',
  ],
  comparacao: [
    'outras crianças', 'os outros já', 'meu filho não faz', 'meu filho ainda não',
    'deveria estar', 'era pra estar', 'já deveria', 'ainda não consegue',
  ],
  acao: [
    'quero agendar', 'quanto custa', 'valor', 'preço', 'horário',
    'disponibilidade', 'quero começar', 'quero marcar', 'pode me ajudar',
    'como funciona atendimento', 'posso ir aí', 'endereço',
  ],
  leve_curiosidade: [
    'vi no instagram', 'vi no site', 'achei interessante', 'curiosa', 'curioso',
    'só uma dúvida', 'só perguntando', 'por curiosidade', 'ouvi falar',
  ],
};

export function detectarIntencaoLead(textoLead = '') {
  if (!textoLead || textoLead.length < 5) {
    return {
      intencao:   'desconhecida',
      confianca:  0,
      estagio_sugerido: 'descoberta',
    };
  }

  const texto  = textoLead.toLowerCase();
  const scores = {};

  Object.entries(INTENCAO_KEYWORDS).forEach(([intencao, keywords]) => {
    scores[intencao] = keywords.filter(kw => texto.includes(kw)).length;
  });

  const entries   = Object.entries(scores);
  const maxScore  = Math.max(...entries.map(([, s]) => s));

  if (maxScore === 0) {
    return {
      intencao:   texto.includes('?') && texto.length < 50 ? 'duvida' : 'preocupacao',
      confianca:  0.4,
      estagio_sugerido: 'descoberta',
    };
  }

  const intencaoDetectada = entries.find(([, s]) => s === maxScore)[0];
  // Confiança calibrada — nunca ultrapassa 0.85 para não gerar falsa certeza
  const confianca = Math.min(maxScore * 0.25 + 0.35, 0.85);

  // Sugestão de estágio baseada na intenção (apenas sugestão — não sobrescreve)
  const mapaEstagio = {
    duvida:           'descoberta',
    preocupacao:      'descoberta',
    comparacao:       'consideracao',
    acao:             'decisao',
    leve_curiosidade: 'descoberta',
  };

  return {
    intencao:        intencaoDetectada,
    confianca,
    estagio_sugerido: mapaEstagio[intencaoDetectada] || 'descoberta',
  };
}

// ═════════════════════════════════────────────
// STORYBOARD + DIREÇÃO DE CENA (Zeus v3.3)
// ═════════════════════════════════────────────

/**
 * Calcula timing flexível baseado na fala e estágio
 */
function calcularTimingPorFala(fala, estagio_jornada) {
  const palavras = fala.split(/\s+/).length;
  const baseSegundos = palavras * 0.5; // 1 palavra ≈ 0.5s
  
  // Ajuste por estágio (ritmo emocional)
  const multiplicador = {
    descoberta: 1.2,     // Mais lento, acolhedor
    consideracao: 1.0,   // Ritmo médio
    decisao: 0.9,        // Mais direto
    retargeting: 1.1,    // Tranquilo
  }[estagio_jornada] || 1.0;
  
  const tempoAjustado = baseSegundos * multiplicador;
  
  // Range de 20% para flexibilidade
  const min = Math.max(tempoAjustado * 0.8, 2);
  const max = tempoAjustado * 1.2;
  
  // Classificação por tipo
  let tipo = 'medio';
  if (max < 4) tipo = 'curto';
  if (min > 6) tipo = 'longo';
  
  return {
    range: `${Math.round(min)}-${Math.round(max)}s`,
    min,
    max,
    tipo,
    palavras
  };
}

/**
 * Define direção visual baseada no estágio e conteúdo da fala
 */
function definirDirecaoVisual(fala, estagio_jornada, indice, totalBlocos) {
  // Análise de emoção da fala
  const temCena = /você|mãe|pai|chamou|brincando/.test(fala.toLowerCase());
  const temProva = /\d|%|em \d+|resultado/.test(fala);
  const tensao = /detalhe|chegar tarde|não percebe|faz sentido/.test(fala.toLowerCase());
  
  // Direção por estágio + contexto
  const direcoes = {
    descoberta: {
      visual: temCena 
        ? 'criança brincando, ignora quando chamada, ambiente doméstico natural'
        : 'mãe observa com expressão de dúvida, close suave no rosto',
      camera: indice === 0 ? 'plano médio, movimento suave' : 'close, foco nos olhos',
      emocao: tensao ? 'curiosidade/tensão suave' : 'neutralidade acolhedora',
      iluminacao: 'luz natural suave, tom quente',
    },
    consideracao: {
      visual: temProva
        ? 'terapeuta interage com criança, ambiente clínico acolhedor'
        : 'mãe presta atenção, gesto de compreensão',
      camera: 'plano médio-fechar, movimento controlado',
      emocao: 'confiança construindo',
      iluminacao: 'luz profissional suave, ambiente clínico',
    },
    decisao: {
      visual: 'terapeuta fala direto para câmera com autoridade gentil',
      camera: 'plano fechado, estabilidade',
      emocao: 'autoridade empática',
      iluminacao: 'luz clara, foco no rosto',
    },
    retargeting: {
      visual: 'ambiente familiar tranquilo, sem pressão',
      camera: 'plano aberto, sensação de espaço',
      emocao: 'cumplicidade/remoção de culpa',
      iluminacao: 'luz suave acolhedora',
    },
  };
  
  const base = direcoes[estagio_jornada] || direcoes.descoberta;
  
  // Ajustes específicos por conteúdo
  if (temProva) {
    base.visual = 'texto sutil na tela ou gráfico leve, cena de transformação';
    base.emocao = 'credibilidade/concreto';
  }
  
  return base;
}

/**
 * Define transição entre blocos
 */
function definirTransicao(indiceAtual, totalBlocos, estagio_jornada) {
  if (indiceAtual === 0) return 'abertura';
  if (indiceAtual === totalBlocos - 1) return 'fade_loop';
  
  // Transições por contexto emocional
  const transicoes = {
    descoberta: ['continuidade natural', 'corte suave', 'fade leve'],
    consideracao: ['corte informativo', 'transição limpa'],
    decisao: ['corte direto', 'continuidade firme'],
    retargeting: ['fade suave', 'continuidade gentil'],
  };
  
  const opcoes = transicoes[estagio_jornada] || transicoes.descoberta;
  return opcoes[indiceAtual % opcoes.length];
}

/**
 * Gera storyboard completo a partir do roteiro
 */
function gerarStoryboard(roteiro, estagio_jornada, perfil) {
  const texto = roteiro.texto_completo;
  
  // Quebrar em blocos por frases (pontos finais, reticências, quebras)
  const frases = texto
    .split(/(?<=[.…!?:])\s+/)
    .map(f => f.trim())
    .filter(f => f.length > 0);
  
  const blocos = [];
  const cenasAbertura = CENAS_ABERTURA[perfil?.subTema] || CENAS_ABERTURA.atraso_fala;
  const cenaInicial = cenasAbertura ? cenasAbertura[0] : 'criança brincando';
  
  frases.forEach((fala, indice) => {
    const timing = calcularTimingPorFala(fala, estagio_jornada);
    const direcao = definirDirecaoVisual(fala, estagio_jornada, indice, frases.length);
    const transicao = definirTransicao(indice, frases.length, estagio_jornada);
    
    // Cena especial para o primeiro bloco (hook)
    if (indice === 0) {
      direcao.visual = cenaInicial;
      direcao.emocao = 'stop-scroll imediato';
    }
    
    blocos.push({
      bloco: indice + 1,
      ordem: indice + 1,
      fala,
      timing_range: timing.range,
      timing_tipo: timing.tipo,
      visual: direcao.visual,
      camera: direcao.camera,
      emocao: direcao.emocao,
      iluminacao: direcao.iluminacao,
      transicao,
    });
  });
  
  return {
    blocos,
    meta: {
      total_blocos: blocos.length,
      duracao_estimada: blocos.reduce((acc, b) => acc + parseInt(b.timing_range.split('-')[1]), 0),
      estagio_jornada,
    }
  };
}

/**
 * Gera prompt otimizado para Veo a partir do storyboard
 */
function gerarPromptVeo(storyboard, estagio_jornada) {
  const estilos = {
    descoberta: 'Documentary style, soft natural lighting, intimate family moments, gentle camera movement, authentic emotions',
    consideracao: 'Professional clinical documentary, warm lighting, confident atmosphere, smooth camera work',
    decisao: 'Direct documentary, clear lighting, professional authority, steady camera',
    retargeting: 'Soft documentary style, warm forgiving light, peaceful atmosphere, gentle transitions',
  };
  
  const cenas = storyboard.blocos.map((bloco, i) => {
    return `Cena ${i + 1} (${bloco.timing_range}): ${bloco.visual}. ${bloco.camera}. ${bloco.iluminacao}. Emoção: ${bloco.emocao}. Transição: ${bloco.transicao}.`;
  }).join('\n\n');
  
  return {
    estilo_base: estilos[estagio_jornada] || estilos.descoberta,
    direcao_cinematografica: cenas,
    loop_hint: estagio_jornada === 'descoberta' 
      ? 'Final scene should visually connect to opening, creating seamless loop'
      : 'Clear ending with emotional resolution',
    aspect_ratio: '9:16 vertical',
    qualidade: 'cinematic, professional healthcare documentary',
  };
}

// Exportações para testes unitários
export { scorarConversao, TOM_POR_ESTAGIO, MAPEAMENTO_JORNADA, CENAS_ABERTURA, montarHashtags, gerarStoryboard, gerarPromptVeo };

export default { gerarRoteiro, detectarIntencaoLead };
