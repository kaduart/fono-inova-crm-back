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
// AMPLO: cada especialidade acessa muitos layouts para máxima variedade
export const ESPECIALIDADE_CATEGORIAS = {
  fonoaudiologia: [
    'foto_terapia', 'educativo', 'tecnico', 'educativo_comparativo',
    'informativo_lista', 'video', 'beneficios', 'emocional',
    'quote_impacto', 'dica_rapida', 'autoridade', 'banner_lateral',
    'conscientizacao', 'motora'
  ],
  psicologia: [
    'emocional', 'educativo', 'conscientizacao', 'beneficios',
    'foto_terapia', 'informativo_lista', 'video', 'quote_impacto',
    'dica_rapida', 'banner_lateral', 'autoridade', 'escolar'
  ],
  terapia_ocupacional: [
    'foto_terapia', 'ilustracao', 'beneficios', 'educativo',
    'video', 'conscientizacao', 'quote_impacto', 'dica_rapida',
    'informativo_lista', 'banner_lateral', 'emocional', 'motora'
  ],
  fisioterapia: [
    'foto_terapia', 'motora', 'beneficios', 'educativo',
    'video', 'autoridade', 'quote_impacto', 'dica_rapida',
    'banner_lateral', 'conscientizacao', 'emocional'
  ],
  neuropsicologia: [
    'emocional', 'conscientizacao', 'educativo', 'foto_terapia',
    'video', 'informativo_lista', 'quote_impacto', 'dica_rapida',
    'banner_lateral', 'autoridade', 'escolar'
  ],
  psicopedagogia: [
    'escolar', 'educativo', 'beneficios', 'foto_terapia',
    'conscientizacao', 'video', 'quote_impacto', 'dica_rapida',
    'informativo_lista', 'emocional', 'banner_lateral'
  ],
  datas: [
    'datas', 'foto_terapia', 'video', 'quote_impacto',
    'banner_lateral', 'dica_rapida'
  ],
  institucional: [
    'institucional', 'marca', 'autoridade', 'video',
    'foto_terapia', 'beneficios', 'quote_impacto',
    'banner_lateral', 'dica_rapida'
  ]
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
      fotoRatio: 0.62,
      crop: 'entropy',
      elementos: [
        {
          // Cunha amarela topo direito — maior e mais visível
          tipo: 'path_curvo',
          cor: 'amareloOuro',
          posicao: 'topo_direito',
          path: 'M1080,0 L780,0 C850,30 970,120 980,230 C988,310 1050,290 1080,310 Z',
          opacidade: 0.90
        },
        {
          // Blob lilás reposicionado para ficar visível na borda da faixa
          tipo: 'blob',
          cor: 'lilas',
          posicao: 'inferior_esquerdo',
          path: 'M-90,650 C50,560 260,620 230,780 C200,920 20,970 -90,900 Z',
          opacidade: 0.82
        },
        {
          tipo: 'faixa',
          cor: 'verdeProfundo',
          posicao: 'inferior',
          yStart: 670,
          height: 410,
          curva: true,
          gradiente: true,
          corGradiente: '#0C2518'
        }
      ],
      texto: {
        titulo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 58,
          cor: 'branco',
          maxChars: 26,
          x: 75,
          y: 800,
          shadow: true
        },
        subtitulo: {
          fonte: 'Montserrat',
          peso: '500',
          tamanho: 24,
          cor: 'branco',
          x: 75,
          y: 960,
          maxChars: 58
        }
      },
      detalhe: {
        tipo: 'linha_decorativa',
        cor: 'amareloOuro',
        x: 75,
        y: 1005,
        width: 140,
        height: 5
      },
      marca: {
        tipo: 'marca_texto',
        texto: 'FONO INOVA',
        cor: 'branco',
        x: 75,
        y: 1050,
        tamanho: 18,
        opacidade: 0.75
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
        // Painel rosa direito
        {
          tipo: 'retangulo',
          cor: 'rosaClaro',
          x: 540,
          y: 0,
          width: 540,
          height: 1080,
          opacidade: 0.93
        },
        // Acento lilás topo direito
        {
          tipo: 'circulo',
          cor: 'lilas',
          cx: 900,
          cy: 160,
          r: 110,
          opacidade: 0.55
        },
        // Losango/circulo amarelo na borda central
        {
          tipo: 'circulo',
          cor: 'amareloOuro',
          cx: 540,
          cy: 900,
          r: 75,
          opacidade: 0.88
        }
      ],
      texto: {
        titulo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 48,
          cor: 'verdeProfundo',
          x: 580,
          y: 720,
          align: 'left',
          maxChars: 22,
          shadow: true
        },
        subtitulo: {
          fonte: 'Montserrat',
          peso: '500',
          tamanho: 24,
          cor: 'verdeProfundo',
          x: 580,
          y: 870,
          align: 'left',
          maxChars: 42
        }
      },
      marca: {
        tipo: 'marca_texto',
        texto: 'FONO INOVA',
        cor: 'verdeProfundo',
        x: 580,
        y: 1048,
        tamanho: 18,
        opacidade: 0.65
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
      fotoRatio: 0.68,
      crop: 'center',
      bg: 'amareloOuro',
      elementos: [
        // Faixa amarela com curva no inferior
        {
          tipo: 'faixa',
          cor: 'amareloOuro',
          yStart: 720,
          height: 360,
          curva: true,
          gradiente: true,
          corGradiente: '#C8A800'
        },
        // Losango grande — destaque topo esquerdo
        {
          tipo: 'losango',
          cor: 'verdeProfundo',
          cx: 100,
          cy: 100,
          size: 90,
          opacidade: 0.88
        },
        // Losango acento direito
        {
          tipo: 'losango',
          cor: 'verdeProfundo',
          cx: 1000,
          cy: 820,
          size: 60,
          opacidade: 0.70
        },
        // Losango contorno decorativo
        {
          tipo: 'losango',
          cor: 'verdeProfundo',
          cx: 960,
          cy: 120,
          size: 45,
          contorno: true,
          espessura: 4,
          opacidade: 0.55
        }
      ],
      texto: {
        titulo: {
          fonte: 'Montserrat',
          peso: '700',
          tamanho: 50,
          cor: 'verdeProfundo',
          x: 75,
          y: 860,
          maxChars: 26,
          shadow: true
        },
        subtitulo: {
          fonte: 'Montserrat',
          peso: '500',
          tamanho: 26,
          cor: 'verdeProfundo',
          x: 75,
          y: 980,
          maxChars: 50
        }
      },
      marca: {
        tipo: 'marca_texto',
        texto: 'FONO INOVA',
        cor: 'verdeProfundo',
        x: 75,
        y: 1048,
        tamanho: 18,
        opacidade: 0.70
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
        // Gradiente inferior para contraste do texto
        {
          tipo: 'gradiente',
          direcao: 'bottom',
          corStart: 'transparent',
          corEnd: 'verdeProfundo',
          opacidade: 0.88,
          height: 380
        },
        // Play button central
        {
          tipo: 'play_button',
          cor: 'branco',
          cx: 540,
          cy: 430,
          size: 120,
          opacidade: 0.90
        },
        // Losangos decorativos nos cantos
        {
          tipo: 'losango',
          cor: 'amareloOuro',
          cx: 80,
          cy: 80,
          size: 65,
          opacidade: 0.85
        },
        {
          tipo: 'losango',
          cor: 'amareloOuro',
          cx: 1000,
          cy: 80,
          size: 65,
          opacidade: 0.85
        },
        {
          tipo: 'losango',
          cor: 'branco',
          cx: 80,
          cy: 80,
          size: 35,
          contorno: true,
          espessura: 3,
          opacidade: 0.50
        }
      ],
      texto: {
        hook: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 46,
          cor: 'amareloOuro',
          x: 540,
          y: 880,
          align: 'center',
          maxChars: 28,
          shadow: true
        },
        subtitulo: {
          fonte: 'Montserrat',
          peso: '600',
          tamanho: 26,
          cor: 'branco',
          x: 540,
          y: 990,
          align: 'center',
          maxChars: 48
        }
      },
      marca: {
        tipo: 'marca_texto',
        texto: 'FONO INOVA',
        cor: 'branco',
        x: 540,
        y: 1050,
        tamanho: 18,
        opacidade: 0.70
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
      fotoRatio: 0.68,
      crop: 'center',
      bg: 'branco',
      elementos: [
        // Faixa branca/cinza inferior com curva
        {
          tipo: 'faixa',
          cor: 'verdeProfundo',
          yStart: 655,
          height: 425,
          curva: true,
          gradiente: true,
          corGradiente: '#0C2518'
        },
        // Losango grande amarelo — autoridade topo direito
        {
          tipo: 'losango',
          cor: 'amareloOuro',
          cx: 980,
          cy: 110,
          size: 120,
          opacidade: 0.92
        },
        // Losango verde — acento topo esquerdo
        {
          tipo: 'losango',
          cor: 'verdeVibrante',
          cx: 80,
          cy: 80,
          size: 72,
          opacidade: 0.80
        },
        // Losango na faixa — direita
        {
          tipo: 'losango',
          cor: 'amareloOuro',
          cx: 1010,
          cy: 800,
          size: 65,
          opacidade: 0.85
        },
        // Losango contorno — acento faixa esquerda
        {
          tipo: 'losango',
          cor: 'verdeClaro',
          cx: 55,
          cy: 770,
          size: 48,
          contorno: true,
          espessura: 4,
          opacidade: 0.60
        },
        // Badge MÉTODO
        {
          tipo: 'badge',
          texto: 'MÉTODO',
          cor: 'amareloOuro',
          x: 750,
          y: 100,
          padding: 20,
          borderRadius: 30
        }
      ],
      texto: {
        metodo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 62,
          cor: 'branco',
          x: 75,
          y: 800,
          maxChars: 22,
          shadow: true
        },
        credenciais: {
          fonte: 'Montserrat',
          peso: '500',
          tamanho: 26,
          cor: 'branco',
          x: 75,
          y: 950,
          maxChars: 52
        }
      },
      detalhe: {
        tipo: 'linha_decorativa',
        cor: 'amareloOuro',
        x: 75,
        y: 992,
        width: 140,
        height: 5
      },
      marca: {
        tipo: 'marca_texto',
        texto: 'FONO INOVA',
        cor: 'branco',
        x: 75,
        y: 1050,
        tamanho: 18,
        opacidade: 0.75
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
      fotoRatio: 0.42,
      crop: 'center',
      bg: 'rosaClaro',
      elementos: [
        // Faixa rosa inferior
        {
          tipo: 'faixa',
          cor: 'rosaClaro',
          yStart: 440,
          height: 640,
          curva: true,
          gradiente: true,
          corGradiente: '#E8A0A0'
        },
        // Losangos decorativos
        {
          tipo: 'losango',
          cor: 'verdeProfundo',
          cx: 970,
          cy: 115,
          size: 95,
          opacidade: 0.88
        },
        {
          tipo: 'losango',
          cor: 'amareloOuro',
          cx: 80,
          cy: 80,
          size: 68,
          opacidade: 0.82
        },
        {
          tipo: 'losango',
          cor: 'verdeProfundo',
          cx: 1005,
          cy: 700,
          size: 55,
          opacidade: 0.70
        },
        // Lista de benefícios com bullets
        {
          tipo: 'lista',
          items: 4,
          cor: 'verdeProfundo'
        }
      ],
      texto: {
        titulo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 50,
          cor: 'verdeProfundo',
          x: 75,
          y: 600,
          maxChars: 26,
          shadow: true
        },
        subtitulo: {
          fonte: 'Montserrat',
          peso: '500',
          tamanho: 24,
          cor: 'verdeProfundo',
          x: 75,
          y: 950,
          maxChars: 55
        }
      },
      detalhe: {
        tipo: 'linha_decorativa',
        cor: 'verdeProfundo',
        x: 75,
        y: 985,
        width: 120,
        height: 5
      },
      marca: {
        tipo: 'marca_texto',
        texto: 'FONO INOVA',
        cor: 'verdeProfundo',
        x: 75,
        y: 1050,
        tamanho: 18,
        opacidade: 0.70
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
      fotoRatio: 0.72,
      crop: 'center',
      bg: 'verdeProfundo',
      elementos: [
        // Overlay gradiente inferior
        {
          tipo: 'faixa',
          cor: 'verdeProfundo',
          yStart: 590,
          height: 490,
          curva: true,
          gradiente: true,
          corGradiente: '#081A10'
        },
        // Losango amarelo — destaque topo direito
        {
          tipo: 'losango',
          cor: 'amareloOuro',
          cx: 1000,
          cy: 100,
          size: 100,
          opacidade: 0.90
        },
        // Losango verde claro — acento esquerdo
        {
          tipo: 'losango',
          cor: 'verdeClaro',
          cx: 60,
          cy: 650,
          size: 55,
          opacidade: 0.65
        },
        // Losango contorno amarelo — faixa direita
        {
          tipo: 'losango',
          cor: 'amareloOuro',
          cx: 1020,
          cy: 820,
          size: 60,
          contorno: true,
          espessura: 4,
          opacidade: 0.65
        }
      ],
      texto: {
        titulo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 54,
          cor: 'branco',
          x: 75,
          y: 770,
          maxChars: 24,
          shadow: true
        },
        subtitulo: {
          fonte: 'Montserrat',
          peso: '600',
          tamanho: 26,
          cor: 'amareloOuro',
          x: 75,
          y: 930,
          maxChars: 52
        }
      },
      detalhe: {
        tipo: 'linha_decorativa',
        cor: 'amareloOuro',
        x: 75,
        y: 975,
        width: 140,
        height: 5
      },
      marca: {
        tipo: 'marca_texto',
        texto: 'FONO INOVA',
        cor: 'branco',
        x: 75,
        y: 1048,
        tamanho: 18,
        opacidade: 0.75
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
      fotoRatio: 0.52,
      crop: 'center',
      bg: 'azul',
      elementos: [
        // Faixa azul escura inferior
        {
          tipo: 'faixa',
          cor: 'azul',
          yStart: 600,
          height: 480,
          curva: true,
          gradiente: true,
          corGradiente: '#1A237E'
        },
        // Losangos coloridos — impacto visual alto
        {
          tipo: 'losango',
          cor: 'amareloOuro',
          cx: 980,
          cy: 100,
          size: 100,
          opacidade: 0.92
        },
        {
          tipo: 'losango',
          cor: 'rosaCoral',
          cx: 80,
          cy: 80,
          size: 70,
          opacidade: 0.85
        },
        {
          tipo: 'losango',
          cor: 'verdeClaro',
          cx: 1010,
          cy: 760,
          size: 65,
          opacidade: 0.80
        },
        {
          tipo: 'losango',
          cor: 'amareloOuro',
          cx: 50,
          cy: 720,
          size: 45,
          contorno: true,
          espessura: 4,
          opacidade: 0.65
        },
        // Elipses coloridas no fundo inferior
        {
          tipo: 'maos_coloridas',
          cores: ['amareloOuro', 'rosaCoral', 'verdeClaro'],
          yStart: 680
        }
      ],
      texto: {
        titulo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 60,
          cor: 'branco',
          x: 75,
          y: 780,
          maxChars: 22,
          shadow: true
        },
        subtitulo: {
          fonte: 'Montserrat',
          peso: '600',
          tamanho: 26,
          cor: 'amareloOuro',
          x: 75,
          y: 945,
          maxChars: 50
        }
      },
      detalhe: {
        tipo: 'linha_decorativa',
        cor: 'amareloOuro',
        x: 75,
        y: 985,
        width: 140,
        height: 5
      },
      marca: {
        tipo: 'marca_texto',
        texto: 'FONO INOVA',
        cor: 'branco',
        x: 75,
        y: 1050,
        tamanho: 18,
        opacidade: 0.75
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
      fotoRatio: 0.58,
      crop: 'center',
      bg: 'amareloClaro',
      elementos: [
        // Faixa rosa/pêssego inferior
        {
          tipo: 'faixa',
          cor: 'rosaClaro',
          yStart: 640,
          height: 440,
          curva: true,
          gradiente: true,
          corGradiente: '#E8949A'
        },
        // Losangos decorativos
        {
          tipo: 'losango',
          cor: 'rosaCoral',
          cx: 970,
          cy: 100,
          size: 95,
          opacidade: 0.88
        },
        {
          tipo: 'losango',
          cor: 'lilas',
          cx: 85,
          cy: 75,
          size: 68,
          opacidade: 0.80
        },
        {
          tipo: 'losango',
          cor: 'amareloOuro',
          cx: 1005,
          cy: 760,
          size: 58,
          opacidade: 0.82
        },
        {
          tipo: 'losango',
          cor: 'rosaCoral',
          cx: 55,
          cy: 730,
          size: 44,
          contorno: true,
          espessura: 4,
          opacidade: 0.60
        }
      ],
      texto: {
        titulo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 54,
          cor: 'verdeProfundo',
          x: 75,
          y: 790,
          maxChars: 24,
          shadow: true
        },
        subtitulo: {
          fonte: 'Montserrat',
          peso: '500',
          tamanho: 24,
          cor: 'verdeProfundo',
          x: 75,
          y: 945,
          maxChars: 55
        }
      },
      detalhe: {
        tipo: 'linha_decorativa',
        cor: 'verdeProfundo',
        x: 75,
        y: 985,
        width: 120,
        height: 5
      },
      marca: {
        tipo: 'marca_texto',
        texto: 'FONO INOVA',
        cor: 'verdeProfundo',
        x: 75,
        y: 1050,
        tamanho: 18,
        opacidade: 0.70
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
      fotoRatio: 0.65,
      crop: 'center',         // Mantém o personagem centralizado
      bg: 'branco',
      elementos: [
        // Faixa verde com gradiente e curva
        {
          tipo: 'faixa',
          cor: 'verdeProfundo',
          yStart: 640,
          height: 440,
          curva: true,
          gradiente: true,
          corGradiente: '#0C2518'
        },
        // Losango grande amarelo — topo direito (destaque principal)
        {
          tipo: 'losango',
          cor: 'amareloOuro',
          cx: 970,
          cy: 115,
          size: 115,
          opacidade: 0.93
        },
        // Losango médio lilás — topo esquerdo (acento)
        {
          tipo: 'losango',
          cor: 'lilas',
          cx: 85,
          cy: 85,
          size: 75,
          opacidade: 0.82
        },
        // Losango amarelo na faixa — direita
        {
          tipo: 'losango',
          cor: 'amareloOuro',
          cx: 1000,
          cy: 760,
          size: 70,
          opacidade: 0.88
        },
        // Losango contorno verde — acento na faixa esquerda
        {
          tipo: 'losango',
          cor: 'verdeClaro',
          cx: 55,
          cy: 750,
          size: 52,
          contorno: true,
          espessura: 5,
          opacidade: 0.70
        }
      ],
      texto: {
        titulo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 54,
          cor: 'branco',
          x: 75,
          y: 790,
          maxChars: 24,
          shadow: true
        },
        subtitulo: {
          fonte: 'Montserrat',
          peso: '500',
          tamanho: 24,
          cor: 'branco',
          x: 75,
          y: 945,
          maxChars: 55
        }
      },
      detalhe: {
        tipo: 'linha_decorativa',
        cor: 'amareloOuro',
        x: 75,
        y: 985,
        width: 140,
        height: 5
      },
      marca: {
        tipo: 'marca_texto',
        texto: 'FONO INOVA',
        cor: 'branco',
        x: 75,
        y: 1050,
        tamanho: 18,
        opacidade: 0.75
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
  // 17. QUOTE IMPACTO (Frase de Impacto)
  // ═══════════════════════════════════════════════════════════
  quote_impacto: {
    id: 'quote_impacto',
    nome: 'Frase de Impacto',
    categoria: 'quote_impacto',
    frequencia: 'alta',
    specs: {
      fotoRatio: 0.55,
      crop: 'center',
      bg: 'verdeProfundo',
      elementos: [
        // Overlay escuro sobre a foto
        {
          tipo: 'faixa',
          cor: 'verdeProfundo',
          yStart: 0,
          height: 1080,
          gradiente: true,
          corGradiente: 'rgba(10,30,18,0.75)'
        },
        // Aspas decorativas — grande
        {
          tipo: 'losango',
          cor: 'amareloOuro',
          cx: 100,
          cy: 340,
          size: 80,
          opacidade: 0.88
        },
        {
          tipo: 'losango',
          cor: 'amareloOuro',
          cx: 980,
          cy: 720,
          size: 80,
          opacidade: 0.88
        },
        {
          tipo: 'losango',
          cor: 'lilas',
          cx: 970,
          cy: 100,
          size: 60,
          opacidade: 0.70
        },
        {
          tipo: 'linha_decorativa',
          cor: 'amareloOuro',
          x: 200,
          y: 400,
          width: 680,
          height: 3
        }
      ],
      texto: {
        titulo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 62,
          cor: 'branco',
          x: 540,
          y: 500,
          align: 'center',
          maxChars: 24,
          shadow: true
        },
        subtitulo: {
          fonte: 'Montserrat',
          peso: '400',
          tamanho: 26,
          cor: 'amareloOuro',
          x: 540,
          y: 740,
          align: 'center',
          maxChars: 52
        }
      },
      detalhe: {
        tipo: 'linha_decorativa',
        cor: 'amareloOuro',
        x: 200,
        y: 790,
        width: 680,
        height: 3
      },
      marca: {
        tipo: 'marca_texto',
        texto: 'FONO INOVA',
        cor: 'branco',
        x: 540,
        y: 1048,
        tamanho: 18,
        opacidade: 0.70
      }
    }
  },

  // ═══════════════════════════════════════════════════════════
  // 18. BANNER LATERAL (Foto Lateral + Texto)
  // ═══════════════════════════════════════════════════════════
  banner_lateral: {
    id: 'banner_lateral',
    nome: 'Banner Foto Lateral',
    categoria: 'banner_lateral',
    frequencia: 'alta',
    specs: {
      fotoRatio: 0.50,
      crop: 'center',
      fotoPosicao: 'right',
      bg: 'amareloClaro',
      elementos: [
        // Painel esquerdo verde
        {
          tipo: 'retangulo',
          cor: 'verdeProfundo',
          x: 0,
          y: 0,
          width: 520,
          height: 1080,
          opacidade: 1
        },
        // Losango de transição entre painéis
        {
          tipo: 'losango',
          cor: 'amareloOuro',
          cx: 520,
          cy: 540,
          largura: 70,
          altura: 200,
          opacidade: 0.92
        },
        // Losango topo do painel verde
        {
          tipo: 'losango',
          cor: 'amareloOuro',
          cx: 260,
          cy: 100,
          size: 85,
          opacidade: 0.88
        },
        // Losango decorativo direito
        {
          tipo: 'losango',
          cor: 'verdeProfundo',
          cx: 900,
          cy: 100,
          size: 70,
          opacidade: 0.75
        },
        {
          tipo: 'losango',
          cor: 'verdeProfundo',
          cx: 950,
          cy: 950,
          size: 55,
          contorno: true,
          espessura: 4,
          opacidade: 0.60
        }
      ],
      texto: {
        titulo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 54,
          cor: 'branco',
          x: 60,
          y: 500,
          maxChars: 20,
          shadow: true
        },
        subtitulo: {
          fonte: 'Montserrat',
          peso: '500',
          tamanho: 24,
          cor: 'amareloOuro',
          x: 60,
          y: 680,
          maxChars: 38
        }
      },
      detalhe: {
        tipo: 'linha_decorativa',
        cor: 'amareloOuro',
        x: 60,
        y: 740,
        width: 130,
        height: 5
      },
      marca: {
        tipo: 'marca_texto',
        texto: 'FONO INOVA',
        cor: 'branco',
        x: 60,
        y: 1048,
        tamanho: 18,
        opacidade: 0.75
      }
    }
  },

  // ═══════════════════════════════════════════════════════════
  // 19. DICA RAPIDA (Reels/Story Estilo)
  // ═══════════════════════════════════════════════════════════
  dica_rapida: {
    id: 'dica_rapida',
    nome: 'Dica Rápida',
    categoria: 'dica_rapida',
    frequencia: 'alta',
    specs: {
      fotoRatio: 0.48,
      crop: 'center',
      bg: 'verdeVibrante',
      elementos: [
        // Faixa inferior verde escuro
        {
          tipo: 'faixa',
          cor: 'verdeProfundo',
          yStart: 570,
          height: 510,
          curva: true,
          gradiente: true,
          corGradiente: '#0C2518'
        },
        // Badge "DICA" topo
        {
          tipo: 'badge',
          texto: 'DICA',
          cor: 'amareloOuro',
          x: 75,
          y: 60,
          borderRadius: 22
        },
        // Losangos cantos
        {
          tipo: 'losango',
          cor: 'amareloOuro',
          cx: 980,
          cy: 100,
          size: 90,
          opacidade: 0.90
        },
        {
          tipo: 'losango',
          cor: 'lilas',
          cx: 85,
          cy: 600,
          size: 60,
          opacidade: 0.72
        },
        {
          tipo: 'losango',
          cor: 'verdeClaro',
          cx: 1000,
          cy: 800,
          size: 55,
          contorno: true,
          espessura: 4,
          opacidade: 0.65
        }
      ],
      texto: {
        titulo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 56,
          cor: 'branco',
          x: 75,
          y: 760,
          maxChars: 24,
          shadow: true
        },
        subtitulo: {
          fonte: 'Montserrat',
          peso: '500',
          tamanho: 24,
          cor: 'branco',
          x: 75,
          y: 920,
          maxChars: 55
        }
      },
      detalhe: {
        tipo: 'linha_decorativa',
        cor: 'amareloOuro',
        x: 75,
        y: 965,
        width: 130,
        height: 5
      },
      marca: {
        tipo: 'marca_texto',
        texto: 'FONO INOVA',
        cor: 'branco',
        x: 75,
        y: 1048,
        tamanho: 18,
        opacidade: 0.75
      }
    }
  },

  // ═══════════════════════════════════════════════════════════
  // 20. HERO VERDE ESCURO (Variação escura do hero clássico)
  // ═══════════════════════════════════════════════════════════
  hero_verde_escuro: {
    id: 'hero_verde_escuro',
    nome: 'Hero Verde Escuro',
    categoria: 'foto_terapia',
    frequencia: 'alta',
    specs: {
      fotoRatio: 0.60,
      crop: 'center',
      bg: 'verdeProfundo',
      elementos: [
        {
          tipo: 'faixa',
          cor: '#0D2B1E',
          yStart: 620,
          height: 460,
          curva: true,
          gradiente: true,
          corGradiente: '#060F0A'
        },
        // Losango amarelo grande topo direito
        {
          tipo: 'losango',
          cor: 'amareloOuro',
          cx: 990,
          cy: 110,
          size: 120,
          opacidade: 0.92
        },
        // Blob lilás topo esquerdo
        {
          tipo: 'blob',
          cor: 'lilas',
          path: 'M-60,80 C80,-10 240,60 200,200 C170,310 30,340 -60,260 Z',
          opacidade: 0.70
        },
        // Losango verde claro na faixa
        {
          tipo: 'losango',
          cor: 'verdeClaro',
          cx: 55,
          cy: 740,
          size: 55,
          opacidade: 0.65
        },
        {
          tipo: 'losango',
          cor: 'amareloOuro',
          cx: 1010,
          cy: 780,
          size: 62,
          contorno: true,
          espessura: 4,
          opacidade: 0.70
        }
      ],
      texto: {
        titulo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 58,
          cor: 'branco',
          x: 75,
          y: 800,
          maxChars: 25,
          shadow: true
        },
        subtitulo: {
          fonte: 'Montserrat',
          peso: '500',
          tamanho: 24,
          cor: 'amareloClaro',
          x: 75,
          y: 955,
          maxChars: 56
        }
      },
      detalhe: {
        tipo: 'linha_decorativa',
        cor: 'amareloOuro',
        x: 75,
        y: 1000,
        width: 140,
        height: 5
      },
      marca: {
        tipo: 'marca_texto',
        texto: 'FONO INOVA',
        cor: 'branco',
        x: 75,
        y: 1050,
        tamanho: 18,
        opacidade: 0.75
      }
    }
  },

  // ═══════════════════════════════════════════════════════════
  // 21. HERO AMARELO (Versão quente/vibrante)
  // ═══════════════════════════════════════════════════════════
  hero_amarelo: {
    id: 'hero_amarelo',
    nome: 'Hero Amarelo Vibrante',
    categoria: 'foto_terapia',
    frequencia: 'media',
    specs: {
      fotoRatio: 0.62,
      crop: 'center',
      bg: 'amareloOuro',
      elementos: [
        {
          tipo: 'faixa',
          cor: 'amareloOuro',
          yStart: 650,
          height: 430,
          curva: true,
          gradiente: true,
          corGradiente: '#C8A800'
        },
        // Losangos verdes — contraste com o amarelo
        {
          tipo: 'losango',
          cor: 'verdeProfundo',
          cx: 975,
          cy: 110,
          size: 115,
          opacidade: 0.92
        },
        {
          tipo: 'losango',
          cor: 'verdeVibrante',
          cx: 80,
          cy: 80,
          size: 75,
          opacidade: 0.82
        },
        {
          tipo: 'losango',
          cor: 'verdeProfundo',
          cx: 1005,
          cy: 760,
          size: 65,
          opacidade: 0.85
        },
        {
          tipo: 'losango',
          cor: 'verdeClaro',
          cx: 55,
          cy: 740,
          size: 48,
          contorno: true,
          espessura: 4,
          opacidade: 0.62
        }
      ],
      texto: {
        titulo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 58,
          cor: 'verdeProfundo',
          x: 75,
          y: 800,
          maxChars: 25,
          shadow: true
        },
        subtitulo: {
          fonte: 'Montserrat',
          peso: '500',
          tamanho: 24,
          cor: 'verdeProfundo',
          x: 75,
          y: 958,
          maxChars: 56
        }
      },
      detalhe: {
        tipo: 'linha_decorativa',
        cor: 'verdeProfundo',
        x: 75,
        y: 1002,
        width: 140,
        height: 5
      },
      marca: {
        tipo: 'marca_texto',
        texto: 'FONO INOVA',
        cor: 'verdeProfundo',
        x: 75,
        y: 1050,
        tamanho: 18,
        opacidade: 0.75
      }
    }
  },

  // ═══════════════════════════════════════════════════════════
  // 22. NEURO IMPACTO (Layout neurologia/TDAH impacto alto)
  // ═══════════════════════════════════════════════════════════
  neuro_impacto: {
    id: 'neuro_impacto',
    nome: 'Neuro Impacto',
    categoria: 'conscientizacao',
    frequencia: 'media',
    specs: {
      fotoRatio: 0.58,
      crop: 'center',
      bg: 'preto',
      elementos: [
        {
          tipo: 'faixa',
          cor: 'verdeProfundo',
          yStart: 610,
          height: 470,
          curva: true,
          gradiente: true,
          corGradiente: '#050F08'
        },
        // Losangos coloridos — alto impacto
        {
          tipo: 'losango',
          cor: 'verdeClaro',
          cx: 980,
          cy: 100,
          size: 110,
          opacidade: 0.90
        },
        {
          tipo: 'losango',
          cor: 'amareloOuro',
          cx: 80,
          cy: 80,
          size: 78,
          opacidade: 0.88
        },
        {
          tipo: 'losango',
          cor: 'rosaCoral',
          cx: 1010,
          cy: 780,
          size: 68,
          opacidade: 0.82
        },
        {
          tipo: 'losango',
          cor: 'lilas',
          cx: 55,
          cy: 750,
          size: 52,
          contorno: true,
          espessura: 4,
          opacidade: 0.65
        }
      ],
      texto: {
        titulo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 60,
          cor: 'branco',
          x: 75,
          y: 800,
          maxChars: 22,
          shadow: true
        },
        subtitulo: {
          fonte: 'Montserrat',
          peso: '500',
          tamanho: 26,
          cor: 'verdeClaro',
          x: 75,
          y: 960,
          maxChars: 50
        }
      },
      detalhe: {
        tipo: 'linha_decorativa',
        cor: 'verdeClaro',
        x: 75,
        y: 1002,
        width: 130,
        height: 5
      },
      marca: {
        tipo: 'marca_texto',
        texto: 'FONO INOVA',
        cor: 'branco',
        x: 75,
        y: 1050,
        tamanho: 18,
        opacidade: 0.75
      }
    }
  },

  // ═══════════════════════════════════════════════════════════
  // 23. PSICO ROSA (Layout emocional/psicologia suave)
  // ═══════════════════════════════════════════════════════════
  psico_rosa: {
    id: 'psico_rosa',
    nome: 'Psico Rosa Emocional',
    categoria: 'emocional',
    frequencia: 'media',
    specs: {
      fotoRatio: 0.60,
      crop: 'center',
      bg: 'rosaClaro',
      elementos: [
        {
          tipo: 'faixa',
          cor: 'rosaCoral',
          yStart: 640,
          height: 440,
          curva: true,
          gradiente: true,
          corGradiente: '#C0606A'
        },
        {
          tipo: 'losango',
          cor: 'lilas',
          cx: 975,
          cy: 110,
          size: 112,
          opacidade: 0.90
        },
        {
          tipo: 'losango',
          cor: 'amareloOuro',
          cx: 80,
          cy: 80,
          size: 75,
          opacidade: 0.85
        },
        {
          tipo: 'losango',
          cor: 'lilas',
          cx: 1005,
          cy: 770,
          size: 62,
          opacidade: 0.80
        },
        {
          tipo: 'losango',
          cor: 'branco',
          cx: 55,
          cy: 750,
          size: 48,
          contorno: true,
          espessura: 4,
          opacidade: 0.60
        }
      ],
      texto: {
        titulo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 56,
          cor: 'branco',
          x: 75,
          y: 800,
          maxChars: 24,
          shadow: true
        },
        subtitulo: {
          fonte: 'Montserrat',
          peso: '500',
          tamanho: 24,
          cor: 'branco',
          x: 75,
          y: 950,
          maxChars: 55
        }
      },
      detalhe: {
        tipo: 'linha_decorativa',
        cor: 'amareloOuro',
        x: 75,
        y: 993,
        width: 130,
        height: 5
      },
      marca: {
        tipo: 'marca_texto',
        texto: 'FONO INOVA',
        cor: 'branco',
        x: 75,
        y: 1050,
        tamanho: 18,
        opacidade: 0.75
      }
    }
  },

  // ═══════════════════════════════════════════════════════════
  // 24. ESCOLAR KIDS (Psicopedagogia/dificuldade escolar)
  // ═══════════════════════════════════════════════════════════
  escolar_kids: {
    id: 'escolar_kids',
    nome: 'Escolar Kids',
    categoria: 'escolar',
    frequencia: 'media',
    specs: {
      fotoRatio: 0.62,
      crop: 'center',
      bg: 'amareloClaro',
      elementos: [
        {
          tipo: 'faixa',
          cor: 'verdeProfundo',
          yStart: 660,
          height: 420,
          curva: true,
          gradiente: true,
          corGradiente: '#0C2518'
        },
        // Losangos coloridos estilo kids
        {
          tipo: 'losango',
          cor: 'rosaCoral',
          cx: 975,
          cy: 110,
          size: 108,
          opacidade: 0.90
        },
        {
          tipo: 'losango',
          cor: 'azulClaro',
          cx: 80,
          cy: 80,
          size: 74,
          opacidade: 0.85
        },
        {
          tipo: 'losango',
          cor: 'amareloOuro',
          cx: 1000,
          cy: 770,
          size: 64,
          opacidade: 0.88
        },
        {
          tipo: 'losango',
          cor: 'verdeClaro',
          cx: 55,
          cy: 748,
          size: 50,
          contorno: true,
          espessura: 4,
          opacidade: 0.65
        }
      ],
      texto: {
        titulo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 56,
          cor: 'branco',
          x: 75,
          y: 800,
          maxChars: 24,
          shadow: true
        },
        subtitulo: {
          fonte: 'Montserrat',
          peso: '500',
          tamanho: 24,
          cor: 'branco',
          x: 75,
          y: 952,
          maxChars: 55
        }
      },
      detalhe: {
        tipo: 'linha_decorativa',
        cor: 'rosaCoral',
        x: 75,
        y: 994,
        width: 130,
        height: 5
      },
      marca: {
        tipo: 'marca_texto',
        texto: 'FONO INOVA',
        cor: 'branco',
        x: 75,
        y: 1050,
        tamanho: 18,
        opacidade: 0.75
      }
    }
  },

  // ═══════════════════════════════════════════════════════════
  // 25. AUTORIDADE CLINICA (Institucional forte)
  // ═══════════════════════════════════════════════════════════
  autoridade_clinica: {
    id: 'autoridade_clinica',
    nome: 'Autoridade Clínica',
    categoria: 'autoridade',
    frequencia: 'media',
    specs: {
      fotoRatio: 0.65,
      crop: 'center',
      bg: 'verdeProfundo',
      elementos: [
        {
          tipo: 'faixa',
          cor: 'verdeProfundo',
          yStart: 670,
          height: 410,
          curva: true,
          gradiente: true,
          corGradiente: '#050F08'
        },
        // Losangos dourados — autoridade
        {
          tipo: 'losango',
          cor: 'amareloOuro',
          cx: 980,
          cy: 110,
          size: 120,
          opacidade: 0.93
        },
        {
          tipo: 'losango',
          cor: 'amareloClaro',
          cx: 80,
          cy: 80,
          size: 78,
          opacidade: 0.80
        },
        {
          tipo: 'losango',
          cor: 'amareloOuro',
          cx: 1010,
          cy: 780,
          size: 68,
          opacidade: 0.85
        },
        {
          tipo: 'losango',
          cor: 'amareloOuro',
          cx: 55,
          cy: 755,
          size: 50,
          contorno: true,
          espessura: 4,
          opacidade: 0.65
        },
        // Badge autoridade
        {
          tipo: 'badge',
          texto: 'ESPECIALISTA',
          cor: 'amareloOuro',
          x: 650,
          y: 68,
          borderRadius: 24
        }
      ],
      texto: {
        titulo: {
          fonte: 'Montserrat',
          peso: '900',
          tamanho: 58,
          cor: 'branco',
          x: 75,
          y: 800,
          maxChars: 24,
          shadow: true
        },
        subtitulo: {
          fonte: 'Montserrat',
          peso: '500',
          tamanho: 24,
          cor: 'amareloClaro',
          x: 75,
          y: 955,
          maxChars: 55
        }
      },
      detalhe: {
        tipo: 'linha_decorativa',
        cor: 'amareloOuro',
        x: 75,
        y: 998,
        width: 140,
        height: 5
      },
      marca: {
        tipo: 'marca_texto',
        texto: 'FONO INOVA',
        cor: 'branco',
        x: 75,
        y: 1050,
        tamanho: 18,
        opacidade: 0.75
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
 * Retorna o máximo de layouts possível para garantir variedade
 */
export function getLayoutsForEspecialidade(especialidadeId) {
  const todosLayouts = Object.values(LAYOUTS);
  const categorias = ESPECIALIDADE_CATEGORIAS[especialidadeId] || null;

  // Se não tem mapeamento ou especialidade genérica, retorna todos
  if (!categorias) return todosLayouts;

  const layouts = [];
  categorias.forEach(cat => {
    layouts.push(...getLayoutsByCategoria(cat));
  });

  // Deduplicar por id
  const vistos = new Set();
  const layoutsUnicos = layouts.filter(l => {
    if (vistos.has(l.id)) return false;
    vistos.add(l.id);
    return true;
  });

  // Se pool muito pequena (< 4), complementa com todos os demais layouts
  if (layoutsUnicos.length < 4) {
    const extras = todosLayouts.filter(l => !vistos.has(l.id));
    return [...layoutsUnicos, ...extras];
  }

  return layoutsUnicos;
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
