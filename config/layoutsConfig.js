/**
 * 🎨 Layouts Configuration - Fono Inova
 * 15+ formatos de posts para Instagram
 * Especificações técnicas para renderização
 */

export const CORES_FONO_INOVA = {
  verdeProfundo: '#1A4D3A',
  verdeVibrante: '#2E8B57',
  verdeClaro: '#4CAF50',
  amareloOuro: '#F4D03F',
  amareloClaro: '#FFE082',
  rosaCoral: '#F1948A',
  rosaClaro: '#F5B7B1',
  lilas: '#C39BD3',
  lilasClaro: '#D7BDE2',
  azul: '#3F51B5',
  azulClaro: '#7986CB',
  branco: '#FFFFFF',
  preto: '#1A1A1A',
  cinza: '#666666',
  cinzaClaro: '#F5F5F5'
};

// Mapeamento de especialidades para categorias preferidas
export const ESPECIALIDADE_CATEGORIAS = {
  fonoaudiologia: ['foto_terapia', 'educativo', 'tecnico'],
  psicologia: ['emocional', 'educativo', 'conscientizacao'],
  terapia_ocupacional: ['foto_terapia', 'ilustracao', 'beneficios'],
  fisioterapia: ['foto_terapia', 'motora'],
  neuropsicologia: ['emocional', 'conscientizacao', 'educativo'],
  psicopedagogia: ['escolar', 'educativo', 'beneficios'],
  datas: ['datas'],
  institucional: ['institucional', 'marca']
};

// Categorias genéricas fallback
export const CATEGORIA_FALLBACK = 'foto_terapia';

/**
 * 📐 DEFINIÇÃO DOS 15+ LAYOUTS
 * Cada layout tem specs para renderização dinâmica
 */
export const LAYOUTS = {
  // ═══════════════════════════════════════════════════════════
  // 1. HERO BANNER CURVA (O clássico - mais usado)
  // ═══════════════════════════════════════════════════════════
  hero_banner_curva: {
    id: 'hero_banner_curva',
    nome: 'Banner Curva Clássico',
    categoria: 'foto_terapia',
    frequencia: 'alta',
    specs: {
      fotoRatio: 0.65,
      crop: 'entropy',
      elementos: [
        {
          tipo: 'path_curvo',
          cor: 'amareloOuro',
          posicao: 'topo_direito',
          path: 'M1080,0 L850,0 Q900,50 950,150 T1080,280 Z',
          opacidade: 0.85
        },
        {
          tipo: 'blob',
          cor: 'lilas',
          posicao: 'inferior_esquerdo',
          path: 'M-50,800 Q100,700 200,850 T100,1000 Z',
          opacidade: 0.6
        },
        {
          tipo: 'faixa',
          cor: 'verdeProfundo',
          posicao: 'inferior',
          yStart: 700,
          height: 380,
          curva: true
        }
      ],
      texto: {
        titulo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 64,
          cor: 'branco',
          maxChars: 30,
          x: 70,
          y: 850,
          shadow: true
        },
        subtitulo: {
          fonte: 'Montserrat',
          peso: '600',
          tamanho: 28,
          cor: 'branco',
          x: 70,
          y: 920,
          maxChars: 50
        }
      },
      detalhe: {
        tipo: 'linha_decorativa',
        cor: 'amareloOuro',
        x: 70,
        y: 960,
        width: 120,
        height: 4
      }
    }
  },

  // ═══════════════════════════════════════════════════════════
  // 2. COMPARATIVO LOSANGO (Atraso X Transtorno)
  // ═══════════════════════════════════════════════════════════
  comparativo_losango: {
    id: 'comparativo_losango',
    nome: 'Atraso X Transtorno',
    categoria: 'educativo_comparativo',
    frequencia: 'media',
    specs: {
      fotoRatio: 0, // Ilustração pura
      tipo: 'ilustracao',
      layout: 'two_columns',
      bg: 'verdeVibrante',
      elementos: [
        {
          tipo: 'coluna',
          cor: 'verdeClaro',
          posicao: 'esquerda',
          width: 540,
          titulo: 'ATRASO',
          icone: 'check'
        },
        {
          tipo: 'coluna',
          cor: 'rosaClaro',
          posicao: 'direita',
          width: 540,
          titulo: 'TRANSTORNO',
          icone: 'warning'
        },
        {
          tipo: 'badge_x',
          cor: 'amareloOuro',
          posicao: 'centro',
          size: 80
        }
      ],
      texto: {
        titulo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 56,
          cor: 'branco',
          x: 540,
          y: 100,
          align: 'center'
        },
        colunas: {
          fonte: 'Montserrat',
          peso: '700',
          tamanho: 32,
          cor: 'verdeProfundo'
        }
      }
    }
  },

  // ═══════════════════════════════════════════════════════════
  // 3. DUAL SCREEN PSICO (Tela Dupla Emocional)
  // ═══════════════════════════════════════════════════════════
  dual_screen_psico: {
    id: 'dual_screen_psico',
    nome: 'Tela Dupla Emocional',
    categoria: 'emocional',
    frequencia: 'alta',
    specs: {
      fotoRatio: 0.55,
      crop: 'center',
      bg: 'rosaClaro',
      elementos: [
        {
          tipo: 'retangulo',
          cor: 'rosaClaro',
          posicao: 'direita',
          x: 540,
          y: 0,
          width: 540,
          height: 1080,
          opacidade: 0.95
        },
        {
          tipo: 'circulo',
          cor: 'amareloOuro',
          posicao: 'centro_inferior',
          cx: 540,
          cy: 850,
          r: 100,
          opacidade: 0.9
        }
      ],
      texto: {
        titulo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 52,
          cor: 'verdeProfundo',
          x: 600,
          y: 750,
          align: 'left',
          maxChars: 25
        },
        subtitulo: {
          fonte: 'Montserrat',
          peso: '600',
          tamanho: 32,
          cor: 'branco',
          x: 600,
          y: 820,
          align: 'left'
        }
      }
    }
  },

  // ═══════════════════════════════════════════════════════════
  // 4. CHECKLIST SINAIS (Checklist Sinais Alerta)
  // ═══════════════════════════════════════════════════════════
  checklist_sinais: {
    id: 'checklist_sinais',
    nome: 'Checklist Sinais Alerta',
    categoria: 'informativo_lista',
    frequencia: 'media',
    specs: {
      fotoRatio: 0.30,
      crop: 'top',
      layout: 'grid_2x2',
      bg: 'branco',
      elementos: [
        {
          tipo: 'card',
          cor: 'verdeClaro',
          posicao: 'top_left',
          titulo: 'O QUE ESPERAR',
          icone: 'check',
          opacidade: 0.2
        },
        {
          tipo: 'card',
          cor: 'rosaCoral',
          posicao: 'top_right',
          titulo: 'SINAIS ALERTA',
          icone: 'warning',
          opacidade: 0.2
        }
      ],
      texto: {
        header: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 48,
          cor: 'verdeProfundo',
          x: 540,
          y: 400,
          align: 'center'
        },
        items: {
          fonte: 'Montserrat',
          peso: '400',
          tamanho: 24,
          cor: 'preto'
        }
      }
    }
  },

  // ═══════════════════════════════════════════════════════════
  // 5. DATA COMEMORATIVA
  // ═══════════════════════════════════════════════════════════
  data_comemorativa: {
    id: 'data_comemorativa',
    nome: 'Dia do Profissional',
    categoria: 'datas',
    frequencia: 'baixa',
    specs: {
      fotoRatio: 0.75,
      crop: 'top',
      bg: 'amareloOuro',
      elementos: [
        {
          tipo: 'faixa',
          cor: 'amareloOuro',
          posicao: 'inferior',
          yStart: 810,
          height: 270
        },
        {
          tipo: 'numero_data',
          cor: 'verdeProfundo',
          posicao: 'topo_esquerdo',
          x: 80,
          y: 150,
          size: 120
        }
      ],
      texto: {
        data: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 100,
          cor: 'verdeProfundo',
          x: 80,
          y: 180
        },
        titulo: {
          fonte: 'Montserrat',
          peso: '700',
          tamanho: 48,
          cor: 'verdeProfundo',
          x: 80,
          y: 920
        }
      }
    }
  },

  // ═══════════════════════════════════════════════════════════
  // 6. VIDEO REELS (Frame Vídeo/Reels)
  // ═══════════════════════════════════════════════════════════
  video_reels: {
    id: 'video_reels',
    nome: 'Frame Vídeo/Reels',
    categoria: 'video',
    frequencia: 'alta',
    specs: {
      fotoRatio: 1.0,
      overlay: 'gradiente_inferior',
      elementos: [
        {
          tipo: 'gradiente',
          direcao: 'bottom',
          corStart: 'transparent',
          corEnd: 'verdeProfundo',
          opacidade: 0.8,
          height: 300
        },
        {
          tipo: 'play_button',
          cor: 'branco',
          posicao: 'centro',
          cx: 540,
          cy: 540,
          size: 100,
          opacidade: 0.9
        }
      ],
      texto: {
        hook: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 42,
          cor: 'amareloOuro',
          x: 540,
          y: 900,
          align: 'center',
          stroke: true
        },
        cta: {
          fonte: 'Montserrat',
          peso: '600',
          tamanho: 28,
          cor: 'branco',
          x: 540,
          y: 960,
          align: 'center'
        }
      }
    }
  },

  // ═══════════════════════════════════════════════════════════
  // 7. METODO AUTORIDADE (Layout Autoridade)
  // ═══════════════════════════════════════════════════════════
  metodo_autoridade: {
    id: 'metodo_autoridade',
    nome: 'Layout Autoridade',
    categoria: 'autoridade',
    frequencia: 'baixa',
    specs: {
      fotoRatio: 0.70,
      crop: 'attention',
      bg: 'branco',
      elementos: [
        {
          tipo: 'badge',
          texto: 'MÉTODO',
          cor: 'amareloOuro',
          posicao: 'topo_direito',
          x: 750,
          y: 100,
          padding: 20,
          borderRadius: 30
        },
        {
          tipo: 'linha_decorativa',
          cor: 'verdeVibrante',
          posicao: 'inferior',
          x: 70,
          y: 1000,
          width: 200,
          height: 6
        }
      ],
      texto: {
        metodo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 72,
          cor: 'verdeProfundo',
          x: 70,
          y: 850,
          estilo: 'display'
        },
        credenciais: {
          fonte: 'Montserrat',
          peso: '400',
          tamanho: 28,
          cor: 'cinza',
          x: 70,
          y: 920
        }
      }
    }
  },

  // ═══════════════════════════════════════════════════════════
  // 8. DIFICULDADE ESCOLAR
  // ═══════════════════════════════════════════════════════════
  dificuldade_escolar: {
    id: 'dificuldade_escolar',
    nome: 'Problemas Escolares',
    categoria: 'escolar',
    frequencia: 'media',
    specs: {
      fotoRatio: 0.60,
      crop: 'center',
      filtro: 'preto_branco_50',
      bg: 'branco',
      elementos: [
        {
          tipo: 'borda',
          cor: 'amareloOuro',
          espessura: 8,
          padding: 40
        },
        {
          tipo: 'texto_destaque',
          cor: 'verdeProfundo',
          posicao: 'centro',
          caixa: true,
          bgCaixa: 'branco',
          opacidadeCaixa: 0.9
        }
      ],
      texto: {
        principal: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 56,
          cor: 'verdeProfundo',
          x: 540,
          y: 540,
          align: 'center',
          caixa: true
        },
        sub: {
          fonte: 'Montserrat',
          peso: '400',
          tamanho: 32,
          cor: 'cinza',
          x: 540,
          y: 650,
          align: 'center'
        }
      }
    }
  },

  // ═══════════════════════════════════════════════════════════
  // 9. BENEFICIOS TERAPIA (Lista de Benefícios)
  // ═══════════════════════════════════════════════════════════
  beneficios_terapia: {
    id: 'beneficios_terapia',
    nome: 'Lista de Benefícios',
    categoria: 'beneficios',
    frequencia: 'media',
    specs: {
      fotoRatio: 0.45,
      layout: 'lista_vertical',
      bg: 'rosaClaro',
      elementos: [
        {
          tipo: 'foto_circular',
          posicao: 'topo_direito',
          cx: 900,
          cy: 200,
          r: 100
        },
        {
          tipo: 'lista',
          items: 5,
          icone: 'check_verde',
          cor: 'verdeProfundo'
        }
      ],
      texto: {
        titulo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 48,
          cor: 'verdeVibrante',
          x: 70,
          y: 600
        },
        items: {
          fonte: 'Montserrat',
          peso: '400',
          tamanho: 28,
          cor: 'preto',
          x: 70,
          lineHeight: 50
        }
      }
    }
  },

  // ═══════════════════════════════════════════════════════════
  // 10. ESCOLHA CLINICA (Por Que Escolher)
  // ═══════════════════════════════════════════════════════════
  escolha_clinica: {
    id: 'escolha_clinica',
    nome: 'Por Que Escolher',
    categoria: 'institucional',
    frequencia: 'baixa',
    specs: {
      fotoRatio: 0.80,
      crop: 'entropy',
      bg: 'verdeVibrante',
      elementos: [
        {
          tipo: 'overlay',
          cor: 'verdeProfundo',
          posicao: 'inferior',
          yStart: 600,
          height: 480,
          opacidade: 0.7
        },
        {
          tipo: 'selo',
          texto: 'INTEGRAR E TRANSFORMAR',
          cor: 'amareloOuro',
          posicao: 'inferior',
          x: 540,
          y: 1000,
          align: 'center'
        }
      ],
      texto: {
        titulo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 52,
          cor: 'branco',
          x: 70,
          y: 750
        },
        slogan: {
          fonte: 'Montserrat',
          peso: '600',
          tamanho: 32,
          cor: 'amareloOuro',
          x: 70,
          y: 850
        }
      }
    }
  },

  // ═══════════════════════════════════════════════════════════
  // 11. TDAH CONSCIENTIZACAO
  // ═══════════════════════════════════════════════════════════
  tdah_conscientizacao: {
    id: 'tdah_conscientizacao',
    nome: 'TDAH/Neuro Consciência',
    categoria: 'conscientizacao',
    frequencia: 'media',
    specs: {
      fotoRatio: 0.50,
      bg: 'azul',
      elementos: [
        {
          tipo: 'maos_coloridas',
          cores: ['amareloOuro', 'rosaCoral', 'verdeClaro'],
          posicao: 'inferior',
          yStart: 700
        }
      ],
      texto: {
        titulo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 64,
          cor: 'branco',
          x: 70,
          y: 400,
          impacto: 'alto'
        },
        data: {
          fonte: 'Montserrat',
          peso: '700',
          tamanho: 36,
          cor: 'amareloOuro',
          x: 70,
          y: 500
        }
      }
    }
  },

  // ═══════════════════════════════════════════════════════════
  // 12. DESENVOLVIMENTO FASES
  // ═══════════════════════════════════════════════════════════
  desenvolvimento_fases: {
    id: 'desenvolvimento_fases',
    nome: 'Fases do Desenvolvimento',
    categoria: 'educativo',
    frequencia: 'media',
    specs: {
      fotoRatio: 0.35,
      layout: 'timeline_horizontal',
      bg: 'amareloOuro',
      elementos: [
        {
          tipo: 'etapas',
          numero: 4,
          icones: ['bebe', 'crianca', 'escola', 'adolescente'],
          cores: ['verdeProfundo', 'verdeVibrante', 'lilas', 'rosaCoral']
        },
        {
          tipo: 'linha_progresso',
          cor: 'verdeVibrante',
          espessura: 6,
          y: 750
        }
      ],
      texto: {
        titulo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 48,
          cor: 'verdeProfundo',
          x: 540,
          y: 100,
          align: 'center'
        },
        fases: {
          fonte: 'Montserrat',
          peso: '600',
          tamanho: 24,
          cor: 'verdeProfundo'
        }
      }
    }
  },

  // ═══════════════════════════════════════════════════════════
  // 13. ANSIEDADE INFANTIL
  // ═══════════════════════════════════════════════════════════
  ansiedade_infantil: {
    id: 'ansiedade_infantil',
    nome: 'Ansiedade/Emocional',
    categoria: 'emocional',
    frequencia: 'media',
    specs: {
      fotoRatio: 0.40,
      bg: 'amareloClaro',
      elementos: [
        {
          tipo: 'ilustracao',
          imagem: 'cerebro_coracao',
          posicao: 'direita',
          x: 600,
          y: 200,
          size: 400
        }
      ],
      texto: {
        titulo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 56,
          cor: 'rosaCoral',
          x: 70,
          y: 600
        },
        alerta: {
          fonte: 'Montserrat',
          peso: '600',
          tamanho: 32,
          cor: 'verdeProfundo',
          x: 70,
          y: 680
        }
      }
    }
  },

  // ═══════════════════════════════════════════════════════════
  // 14. FISIOTERAPIA MOTORA
  // ═══════════════════════════════════════════════════════════
  fisioterapia_motora: {
    id: 'fisioterapia_motora',
    nome: 'Fisioterapia Motora',
    categoria: 'motora',
    frequencia: 'media',
    specs: {
      fotoRatio: 0.70,
      crop: 'attention',
      bg: 'branco',
      elementos: [
        {
          tipo: 'forma_organica',
          cor: 'amareloOuro',
          posicao: 'inferior_esquerdo',
          path: 'M0,800 Q200,700 300,900 T0,1080 Z',
          opacidade: 0.8
        }
      ],
      texto: {
        titulo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 52,
          cor: 'verdeProfundo',
          x: 70,
          y: 880,
          shadow: true
        },
        beneficio: {
          fonte: 'Montserrat',
          peso: '600',
          tamanho: 32,
          cor: 'verdeVibrante',
          x: 70,
          y: 950
        }
      }
    }
  },

  // ═══════════════════════════════════════════════════════════
  // 15. ARTE 3D TERAPIA (Ilustração 3D)
  // ═══════════════════════════════════════════════════════════
  arte_3d_terapia: {
    id: 'arte_3d_terapia',
    nome: 'Ilustração 3D Terapia',
    categoria: 'ilustracao',
    frequencia: 'media',
    specs: {
      fotoRatio: 0, // Ilustração pura
      tipo: 'ilustracao',
      estilo: '3d_cartoon',
      bg: 'gradiente_verde_amarelo',
      elementos: [
        {
          tipo: 'personagem_3d',
          acao: 'brincando_blocos',
          posicao: 'centro',
          x: 540,
          y: 500
        },
        {
          tipo: 'props',
          items: ['blocos_coloridos', 'brinquedos'],
          dispersao: 'aleatoria'
        }
      ],
      texto: {
        titulo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 56,
          cor: 'verdeProfundo',
          x: 540,
          y: 950,
          align: 'center',
          shadow: true
        }
      }
    }
  },

  // ═══════════════════════════════════════════════════════════
  // 16. CAA COMUNICACAO (Comunicação Alternativa)
  // ═══════════════════════════════════════════════════════════
  caa_comunicacao: {
    id: 'caa_comunicacao',
    nome: 'Comunicação Alternativa',
    categoria: 'tecnico',
    frequencia: 'media',
    specs: {
      fotoRatio: 0.40,
      layout: 'icon_grid',
      bg: 'verdeVibrante',
      elementos: [
        {
          tipo: 'icone',
          estilo: 'fala',
          cor: 'amareloOuro',
          x: 200,
          y: 300,
          size: 80
        },
        {
          tipo: 'icone',
          estilo: 'prancha_caa',
          cor: 'branco',
          x: 540,
          y: 300,
          size: 80
        },
        {
          tipo: 'destaque',
          formato: 'pill',
          cor: 'amareloOuro',
          texto: 'CAA',
          x: 880,
          y: 300
        }
      ],
      texto: {
        titulo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 48,
          cor: 'branco',
          x: 540,
          y: 600,
          align: 'center'
        },
        explicacao: {
          fonte: 'Montserrat',
          peso: '400',
          tamanho: 26,
          cor: 'verdeClaro',
          x: 540,
          y: 680,
          align: 'center'
        }
      }
    }
  }
};

/**
 * Obtém layouts por categoria
 */
export function getLayoutsByCategoria(categoria) {
  return Object.values(LAYOUTS).filter(l => l.categoria === categoria);
}

/**
 * Obtém layouts compatíveis com uma especialidade
 */
export function getLayoutsForEspecialidade(especialidadeId) {
  const categorias = ESPECIALIDADE_CATEGORIAS[especialidadeId] || [CATEGORIA_FALLBACK];
  const layouts = [];
  
  categorias.forEach(cat => {
    layouts.push(...getLayoutsByCategoria(cat));
  });
  
  // Se não encontrou nenhum, retorna todos os layouts de foto_terapia
  if (layouts.length === 0) {
    return getLayoutsByCategoria(CATEGORIA_FALLBACK);
  }
  
  return layouts;
}

/**
 * Obtém um layout específico pelo ID
 */
export function getLayoutById(layoutId) {
  return LAYOUTS[layoutId] || LAYOUTS.hero_banner_curva;
}

/**
 * Lista todas as categorias disponíveis
 */
export function getAllCategorias() {
  return [...new Set(Object.values(LAYOUTS).map(l => l.categoria))];
}

export default {
  LAYOUTS,
  CORES_FONO_INOVA,
  ESPECIALIDADE_CATEGORIAS,
  CATEGORIA_FALLBACK,
  getLayoutsByCategoria,
  getLayoutsForEspecialidade,
  getLayoutById,
  getAllCategorias
};
