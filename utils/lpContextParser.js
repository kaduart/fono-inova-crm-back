/**
 * lpContextParser.js
 * Detecta qual Landing Page originou o lead com base na primeira mensagem do WhatsApp.
 * Design data-driven: nenhuma saudação hardcoded — o greeting é montado dinamicamente
 * a partir dos campos do lpData (content.quandoProcurar, sinaisAlerta, etc.)
 */

import { LANDING_PAGES_DATA } from '../services/landingPageService.js';

// Mapeamento: categoria da LP → ID de terapia usado pela FSM / _saveTherapy
const LP_CATEGORY_TO_THERAPY_ID = {
  fonoaudiologia:      'speech',
  autismo:             'speech',         // avaliação TEA → fonoaudiologia/neuropsi
  psicologia:          'psychology',
  aprendizagem:        'psychopedagogy',
  terapia_ocupacional: 'occupational_therapy',
  geografica:          null,             // LP genérica de localização → sem terapia pré-definida
};

/**
 * Mapa de padrões por slug de LP.
 * Cada entrada corresponde a uma LP; os patterns batem na mensagem pré-preenchida do CTA
 * ou em variações orgânicas que o lead possa digitar.
 */
const LP_PATTERN_MAP = [
  // ─── FONOAUDIOLOGIA ───────────────────────────────────────────────────────
  {
    slug: 'crianca-2-anos-nao-fala',
    patterns: [
      /crian[çc]a de 2 anos.*n[aã]o fala/i,
      /2 anos.*n[aã]o fala/i,
      /p[aá]gina sobre crian[çc]a de 2 anos/i,
    ],
  },
  {
    slug: 'atraso-na-fala-infantil',
    patterns: [
      /atraso na fala infantil/i,
      /atraso.*fala.*infantil/i,
    ],
  },
  {
    slug: 'troca-letras-crianca',
    patterns: [
      /troca letras/i,
      /troca.*letras.*crian[çc]a/i,
    ],
  },
  {
    slug: 'crianca-nao-forma-frases',
    patterns: [
      /n[aã]o forma frases/i,
      /crian[çc]a.*n[aã]o forma frases/i,
    ],
  },
  {
    slug: 'fala-enrolada-crianca',
    patterns: [
      /fala enrolad[ao]/i,
      /enrola.*falar/i,
    ],
  },
  {
    slug: 'dificuldade-pronunciar-r',
    patterns: [
      /n[aã]o fala o r\b/i,
      /pronunciar.*\br\b/i,
      /\br\b.*pronunciar/i,
      /dificuldade.*pronunciar/i,
    ],
  },
  {
    slug: 'gagueira-infantil',
    patterns: [
      /gagueira/i,
      /gaguej/i,
    ],
  },
  {
    slug: 'fonoaudiologo-anapolis',
    patterns: [
      /avalia[çc][aã]o fonoaudiol[oó]gica.*an[aá]polis/i,
      /fonoaudiol[oó]g.*an[aá]polis/i,
    ],
  },

  // ─── AUTISMO / TEA ────────────────────────────────────────────────────────
  {
    slug: 'sinais-autismo-bebe',
    patterns: [
      /autismo.*beb[eê]/i,
      /beb[eê].*autismo/i,
      /sinais.*autismo.*beb[eê]/i,
    ],
  },
  {
    slug: 'avaliacao-tea-anapolis',
    patterns: [
      /avalia[çc][aã]o.*autismo/i,
      /autismo.*tea/i,
      /avalia[çc][aã]o.*tea/i,
    ],
  },
  {
    slug: 'crianca-nao-responde-nome',
    patterns: [
      /n[aã]o responde.*nome/i,
      /nome.*n[aã]o responde/i,
    ],
  },
  {
    slug: 'crianca-nao-olha-olhos',
    patterns: [
      /n[aã]o olha.*olhos/i,
      /n[aã]o faz contato visual/i,
    ],
  },
  {
    slug: 'sinais-autismo-2-anos',
    patterns: [
      /sinais.*autismo.*2 anos/i,
      /2 anos.*sinais.*autismo/i,
    ],
  },

  // ─── PSICOLOGIA ───────────────────────────────────────────────────────────
  {
    slug: 'crianca-agressiva',
    patterns: [
      /crian[çc]a.*agressiv/i,
      /agressiv.*crian[çc]a/i,
    ],
  },
  {
    slug: 'ansiedade-infantil',
    patterns: [
      /ansiedade.*infantil/i,
      /suspeito.*ansiedade/i,
      /ansiedade.*crian[çc]a/i,
    ],
  },
  {
    slug: 'psicologo-infantil-anapolis',
    patterns: [
      /psic[oó]logo.*infantil.*an[aá]polis/i,
      /psicologia.*infantil.*an[aá]polis/i,
    ],
  },

  // ─── APRENDIZAGEM / PSICOPEDAGOGIA ────────────────────────────────────────
  {
    slug: 'crianca-nao-aprende-ler',
    patterns: [
      /dificuldade.*ler/i,
      /n[aã]o.*aprend.*ler/i,
      /n[aã]o consegue ler/i,
    ],
  },
  {
    slug: 'sinais-dislexia',
    patterns: [
      /dislexia/i,
    ],
  },
  {
    slug: 'crianca-troca-letras-escrita',
    patterns: [
      /troca letras.*escrita/i,
      /escrita.*troca letras/i,
    ],
  },

  // ─── TERAPIA OCUPACIONAL ──────────────────────────────────────────────────
  {
    slug: 'dificuldade-coordenacao-motora',
    patterns: [
      /coordena[çc][aã]o motora/i,
      /dificuldade.*motor/i,
    ],
  },
  {
    slug: 'terapia-ocupacional-anapolis',
    patterns: [
      /terapia ocupacional.*an[aá]polis/i,
      /terapia.*ocupacional/i,
    ],
  },
];

/**
 * Tenta identificar qual LP originou a mensagem do lead.
 *
 * @param {string} text - Primeira mensagem recebida via WhatsApp
 * @returns {{ slug, therapy, complaint, lpData } | null}
 *   - slug: identificador da LP
 *   - therapy: ID da terapia para a FSM (ex: 'speech', 'psychology')
 *   - complaint: texto resumido da queixa (headline da LP)
 *   - lpData: objeto completo da LP (para montar saudação dinâmica)
 */
export function extractLPContext(text) {
  if (!text) return null;

  for (const { slug, patterns } of LP_PATTERN_MAP) {
    if (patterns.some(p => p.test(text))) {
      const lpData = LANDING_PAGES_DATA.find(lp => lp.slug === slug);
      if (!lpData) continue;

      const therapyId = LP_CATEGORY_TO_THERAPY_ID[lpData.category] ?? null;
      if (!therapyId) return null; // LP geográfica ou sem mapeamento → fluxo genérico

      return {
        slug,
        therapy: therapyId,
        complaint: lpData.headline,
        lpData,
      };
    }
  }

  return null;
}
