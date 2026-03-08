/**
 * 🎬 ZEUS — Gerador de Roteiros de Vídeo
 * 
 * Cria roteiros estruturados para talking head (avatar falando)
 * Saída: JSON com texto_completo, hook, CTA, copy_anuncio
 */

import OpenAI from 'openai';
import logger from '../utils/logger.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Mapeamento de especialidades para profissionais
const ESPECIALIDADE_PROFISSIONAL = {
  fonoaudiologia:      'fono_ana',
  psicologia:          'psico_bia',
  terapia_ocupacional: 'to_carla',
  terapiaocupacional:  'to_carla',
  neuropsicologia:     'neuro_dani',
  fisioterapia:        'fisio_edu',
  musicoterapia:       'musico_fer',
  geral:               'fono_ana'
};

// Nome amigável do profissional
const NOMES_PROFISSIONAL = {
  fono_ana:   'Ana (Fonoaudiologia)',
  psico_bia:  'Bia (Psicologia)',
  to_carla:   'Carla (Terapia Ocupacional)',
  neuro_dani: 'Dani (Neuropsicologia)',
  fisio_edu:  'Edu (Fisioterapia)',
  musico_fer: 'Fer (Musicoterapia)'
};

const ZEUS_SYSTEM_PROMPT = `Você é ZEUS, o roteirista de vídeo da Clínica Fono Inova.
Você escreve roteiros para TALKING HEAD (profissional falando pra câmera).

O vídeo será gerado automaticamente no HeyGen. O avatar da profissional 
vai falar EXATAMENTE o texto que você escrever. Por isso:

REGRAS DO ROTEIRO:
1. Escreva como FALA, não como escreve. Frases curtas. Tom de conversa.
2. Máximo 150 palavras por minuto (ritmo natural, não corrido)
3. NUNCA usar jargão clínico pesado. Mãe leiga precisa entender.
4. Hook nos primeiros 5 segundos — ou perde a audiência
5. Estrutura obrigatória por tempo:
   [0-5s]   HOOK — frase impactante, pergunta ou dado chocante
   [5-20s]  CONTEXTO — desenvolver o tema com empatia
   [20-40s] VALOR — informação útil, dica prática, explicação clara
   [40-50s] SOLUÇÃO — como a Fono Inova resolve (sem vender demais)
   [50-60s] CTA — chamar pro WhatsApp com 💚

6. Compliance saúde (obrigatório):
   ❌ "Seu filho tem autismo?" → ✅ "Crianças no espectro podem apresentar..."
   ❌ "Vamos curar" → ✅ "Vamos acompanhar o desenvolvimento"
   ❌ "Tratamento definitivo" → ✅ "Terapia regular e acompanhamento"
   
7. Tom: acolhedor, empático, como uma amiga especialista, NÃO robótico

Retorne APENAS o JSON solicitado, sem markdown, sem explicações.`;

/**
 * Gera roteiro de vídeo completo
 */
export async function gerarRoteiro({ tema, especialidade, funil = 'TOPO', duracao = 60, tone = 'educativo' }) {
  const profissional = ESPECIALIDADE_PROFISSIONAL[especialidade?.toLowerCase()] || 'fono_ana';
  const nomeProfissional = NOMES_PROFISSIONAL[profissional];
  
  // Definir instruções de tom baseado no parâmetro tone
  const toneInstructions = {
    emotional: 'Tom EMOCIONAL: toque na dor, angústia e urgência. Use empatia profunda, fale sobre os desafios emocionais das mães. Crie conexão através da vulnerabilidade.',
    educativo: 'Tom EDUCATIVO: ensine algo novo de forma clara e acessível. Use exemplos práticos, dados simples e dicas aplicáveis. Mãe deve sair mais informada.',
    inspiracional: 'Tom INSPIRACIONAL: histórias de superação, transformação e esperança. Mostre que é possível evoluir. Final motivador que eleve a autoestima.',
    bastidores: 'Tom BASTIDORES: mostre o dia a dia da clínica, equipe em ação, momentos reais. Humanize, mostre proximidade e o ambiente acolhedor.'
  };
  
  const toneInstruction = toneInstructions[tone] || toneInstructions.educativo;
  
  logger.info(`[ZEUS] Gerando roteiro: "${tema}" | ${nomeProfissional} | ${funil} | Tom: ${tone}`);

  const userPrompt = `Tema: "${tema}"
Especialidade: ${especialidade}
Profissional: ${nomeProfissional}
Funil: ${funil} (${funil === 'TOPO' ? 'educativo/conscientização' : funil === 'MEIO' ? 'institucional/confiança' : 'conversão/agendamento'})
Duração alvo: ${duracao} segundos (~${Math.floor(duracao * 2.2)} palavras)
TOM DE VOZ: ${toneInstruction}

Gere o roteiro em formato JSON:
{
  "roteiro": {
    "titulo": "título curto pra nomear o arquivo (max 40 chars, snake_case)",
    "profissional": "${profissional}",
    "duracao_estimada": ${duracao},
    "texto_completo": "texto EXATO que a profissional vai falar, corrido, como conversa",
    "hook_texto_overlay": "frase curta impactante pros primeiros 3 segundos em tela (max 8 palavras)",
    "cta_texto_overlay": "Fale com a gente no WhatsApp 💚",
    "hashtags": ["hashtag1", "hashtag2", "hashtag3"],
    "copy_anuncio": {
      "texto_primario": "copy pro anúncio Meta, 2-3 linhas, tom pessoal",
      "headline": "headline curta 5-8 palavras",
      "descricao": "descrição secundária 1 frase"
    }
  }
}`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: ZEUS_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.75,
      max_tokens: 1500,
      response_format: { type: 'json_object' }
    });

    const resultado = JSON.parse(response.choices[0].message.content);
    
    // Validações básicas
    if (!resultado.roteiro?.texto_completo) {
      throw new Error('ZEUS retornou roteiro sem texto_completo');
    }
    
    // Contagem de palavras
    const palavras = resultado.roteiro.texto_completo.split(/\s+/).length;
    logger.info(`[ZEUS] ✅ Roteiro gerado: ${palavras} palavras | ${resultado.roteiro.profissional}`);
    
    return resultado;

  } catch (error) {
    logger.error('[ZEUS] Erro ao gerar roteiro:', error.message);
    throw error;
  }
}

export default { gerarRoteiro };
