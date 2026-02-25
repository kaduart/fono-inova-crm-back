/**
 * 🏛️ HERACLES — Nomeador de Campanhas e Gerenciador de Funis
 * 
 * Padrão de nomenclatura: CLINICA_[FUNIL]_[ESPECIALIDADE]_[FORMATO]_[YYYYMM]
 * Exemplo: FONOINOVA_TOPO_FONO_REELS_202502
 */

// Mapeamento de funis
export const FUNIS = {
  topo:  'TOPO',
  meio:  'MEIO',
  fundo: 'FUNDO',
  TOPO:  'TOPO',
  MEIO:  'MEIO',
  FUNDO: 'FUNDO'
};

// Siglas por especialidade
const ESPECIALIDADE_SIGLA = {
  fonoaudiologia:      'FONO',
  psicologia:          'PSICO',
  terapia_ocupacional: 'TO',
  terapiaocupacional:  'TO',
  neuropsicologia:     'NEURO',
  fisioterapia:        'FISIO',
  musicoterapia:       'MUSICO',
  geral:               'GERAL',
  // Mapeamento por ID de profissional também
  fono_ana:            'FONO',
  psico_bia:           'PSICO',
  to_carla:            'TO',
  neuro_dani:          'NEURO',
  fisio_edu:           'FISIO',
  musico_fer:          'MUSICO'
};

/**
 * Gera nome padronizado de campanha Meta
 * @param {Object} params
 * @param {string} params.funil - 'TOPO', 'MEIO', 'FUNDO'
 * @param {string} params.especialidade - ID da especialidade
 * @param {string} params.formato - 'REELS', 'STORIES', 'FEED'
 * @returns {string} Nome da campanha
 */
export function nomearCampanha({ funil = 'TOPO', especialidade = 'geral', formato = 'REELS' }) {
  const sigla = ESPECIALIDADE_SIGLA[especialidade?.toLowerCase()] || 'GERAL';
  const funilNorm = FUNIS[funil] || 'TOPO';
  const mes = new Date().toISOString().slice(0, 7).replace('-', ''); // 202502
  
  return `FONOINOVA_${funilNorm}_${sigla}_${formato}_${mes}`;
}

/**
 * Obtém funil por estágio do vídeo
 * @param {string} funnelStage - 'top', 'middle', 'bottom'
 * @returns {string} Funil normalizado
 */
export function getFunilPorEstagio(funnelStage = 'top') {
  const map = {
    top: 'TOPO',
    middle: 'MEIO',
    bottom: 'FUNDO',
    awareness: 'TOPO',
    consideration: 'MEIO',
    conversion: 'FUNDO'
  };
  return map[funnelStage?.toLowerCase()] || 'TOPO';
}

export default { nomearCampanha, getFunilPorEstagio, FUNIS };
