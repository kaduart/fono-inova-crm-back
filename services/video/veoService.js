/**
 * 🎬 Google Veo 2.0 — Geração de vídeo cinematográfico
 *
 * Usa Google AI Studio (grátis: 50 vídeos/dia, 1500/mês)
 *
 * Setup: GOOGLE_AI_API_KEY no .env (gratuito em aistudio.google.com)
 */

import { GoogleGenAI } from '@google/genai';
import cloudinary from 'cloudinary';
import fs from 'fs';
import path from 'path';
import https from 'https';
import axios from 'axios';
import logger from '../../utils/logger.js';

// Fix WSL2: força IPv4 no download do vídeo (evita fetch failed do undici)
const ipv4HttpsAgent = new https.Agent({ family: 4 });

/**
 * Cenas sequenciais por especialidade — cada clip mostra um momento diferente da jornada.
 * O sufixo "estilo" (câmera, iluminação, look documental) é idêntico em todas as cenas
 * para manter consistência visual. Usa modulo: se numClips > cenas.length, repete variando.
 *
 * Idades: freio_lingual = bebê 14 meses | demais = 4–13 anos conforme enredo
 */
const CENAS_ESPECIALIDADE = {
  fonoaudiologia: {
    estilo: `Bright speech therapy room, soft natural light, light green walls, logopedic mirror visible. Brazilian Latin features, warm brown skin, dark hair. Shallow depth of field, warm medical documentary style, 24fps.`,
    cenas: [
      `8-second shot: Brazilian mother and 5-year-old child arrive at a welcoming speech therapy clinic, female therapist greets them warmly at the door, child peeks shyly behind mom then breaks into a small smile. Camera holds wide then gently pushes in on child's curious face.`,
      `8-second shot: Brazilian female speech therapist holds up colorful picture cards one by one, 5-year-old child points and tries to name each image, brow furrowed in concentration, lips moving carefully. Camera racks focus from cards to child's attentive face.`,
      `8-second shot: 5-year-old child takes a deep breath and blows a soap bubble — it floats up, both child and Brazilian female therapist watch with delight, child's face lights up with joy. Camera follows bubble then returns to child's wide smile.`,
      `8-second shot: 5-year-old child looks into a large speech therapy mirror, Brazilian female therapist stands beside pointing gently at their own lips, demonstrating mouth shapes; child copies carefully, tongue visible. Camera frames both faces in mirror reflection.`,
      `8-second shot: Brazilian female therapist reads a large picture book aloud to a 5-year-old child, child leans in watching the therapist's lips intently, trying to repeat sounds; small victories with each page. Camera slow push-in to child's attentive face.`,
      `8-second shot: 5-year-old child and Brazilian female speech therapist play a sound-matching card game at a colorful table, child concentrates then places the right card and looks up for approval. Camera moves from hands to child's anticipating expression.`,
      `8-second shot: 5-year-old child attempts a tricky word, pauses, tries again — then says it perfectly. Brazilian female therapist's face breaks into a huge proud smile, they share a joyful high five. Camera captures the exact moment of success.`,
      `8-second shot: Brazilian female therapist sits across from a parent showing progress notes, gesturing positively; child plays happily nearby with toys. Parent's face shows visible relief and gratitude. Camera gently alternates between parent and happy child.`
    ]
  },

  psicologia: {
    estilo: `Cozy therapy office, warm natural light through curtains, green plants, calm blue and beige tones. Brazilian Latin features, warm brown skin. Emotional documentary style, 24fps.`,
    cenas: [
      `8-second shot: 13-year-old Brazilian boy walks slowly into a cozy therapy office, sits across from a caring Brazilian female psychologist, arms crossed, eyes down, body tense. Camera wide, slowly pushing in to show both in frame.`,
      `8-second shot: Brazilian female psychologist listens attentively as a 13-year-old boy begins talking, hands in lap, voice quiet; therapist nods gently without interrupting, creating safe space. Camera holds on boy's guarded but opening expression.`,
      `8-second shot: 13-year-old Brazilian boy starts gesturing expressively with his hands while speaking, body language more open; therapist reflects something back and boy nods quickly — feeling understood. Camera follows his hands then his face.`,
      `8-second shot: Brazilian female psychologist hands a journal and pen to a 13-year-old boy; he takes it, opens it slowly and begins writing, brow furrowed, tongue slightly out. Camera overhead slowly tilts down to page then to his focused face.`,
      `8-second shot: 13-year-old Brazilian boy pauses mid-sentence, looks down thinking, touches his chin; Brazilian female psychologist waits patiently, leaning slightly forward. Camera holds on boy's thoughtful introspective face in a quiet meaningful moment.`,
      `8-second shot: Brazilian female psychologist asks a question; 13-year-old boy's eyes widen slightly with recognition — he nods slowly, making real eye contact for the first time in the session. Camera pushes in gently on this moment of connection.`,
      `8-second shot: 13-year-old Brazilian boy slowly uncrosses his arms, leans forward, and breaks into a small relieved genuine smile — the emotional breakthrough moment. Camera begins wide then does a slow rack focus to the boy's expressive face.`,
      `8-second shot: Session ending — 13-year-old Brazilian boy stands, looks taller and lighter; Brazilian female psychologist walks him to the door, he pauses and says something; she smiles warmly. Camera frames both in doorway, boy's posture visibly more open.`
    ]
  },

  terapia_ocupacional: {
    estilo: `Clean occupational therapy room, bright natural light, colorful adaptive materials, sensory toys on shelves. Brazilian Latin features, warm brown skin. Educational documentary style, 24fps.`,
    cenas: [
      `8-second shot: 7-year-old Brazilian child enters the bright OT therapy room, eyes wide, looking at the colorful materials and sensory tools on shelves with wonder. Brazilian female occupational therapist kneels to child's height, welcoming with a warm smile.`,
      `8-second shot: 7-year-old Brazilian child sits at table touching different textured materials — rough, smooth, squishy — making faces of discovery. Brazilian female OT therapist watches closely, taking notes, smiling at the child's reactions. Camera close on hands.`,
      `8-second shot: 7-year-old Brazilian child carefully stacks colorful rings onto a pole, tongue out, highly concentrated; hand trembles then ring slides on successfully. Brazilian female therapist claps softly. Camera overhead then tilts to child's proud face.`,
      `8-second shot: 7-year-old Brazilian child's small fingers thread a colorful wooden bead onto string, almost drops it, regains — fingers trembling then succeeding. Brazilian female OT therapist's hands hover supportively nearby. Camera close on hands and proud face.`,
      `8-second shot: Brazilian female OT therapist holds a piece of paper steady as 7-year-old child cuts carefully along a dotted line with safety scissors, tip of tongue out in concentration. Camera follows scissors then reveals clean cut line and child's proud smile.`,
      `8-second shot: 7-year-old Brazilian child works to fit puzzle pieces together at therapy table, face scrunched in focus. Brazilian female therapist watches without helping. Child finds the fit — face lights up with joy. Camera captures the triumph.`,
      `8-second shot: 7-year-old Brazilian child holds up a finished colorful craft project with both hands, beaming with pride. Brazilian female OT therapist admires it genuinely, nodding and smiling. Camera pulls back slowly to show the whole proud moment.`,
      `8-second shot: 7-year-old Brazilian child runs to show a waiting parent their completed OT project; parent's face lights up with delight. Brazilian female therapist stands in background smiling. Camera frames joyful family reunion and therapist's pride.`
    ]
  },

  fisioterapia: {
    estilo: `Modern bright pediatric physiotherapy clinic, colorful equipment, balance beams and therapy mats. Brazilian Latin features, warm brown skin. Motivational documentary style, 24fps.`,
    cenas: [
      `8-second shot: 9-year-old Brazilian child walks into physiotherapy clinic with a slight limp; parent holds hand. Brazilian female pediatric physiotherapist greets them warmly, kneels to child's level, child manages a small brave smile. Camera wide, push in on child.`,
      `8-second shot: Brazilian female physiotherapist gently moves 9-year-old child's leg on exam table, watching range of motion carefully; child's face shows trust as therapist works gently and explains each step. Camera close on hands and child's trusting face.`,
      `8-second shot: 9-year-old Brazilian child does slow careful stretching exercises on a therapy mat, Brazilian female physiotherapist demonstrates each move with patience, child copies seriously. Camera tracks from therapist demonstrating to child trying.`,
      `8-second shot: 9-year-old Brazilian child walks carefully along colorful balance beam steps, arms out, face showing intense determination. Brazilian female physiotherapist walks beside, one hand gently hovering near child's shoulder. Camera tracks at child's eye level.`,
      `8-second shot: 9-year-old Brazilian child kicks a large therapeutic ball repeatedly against padded wall, leg getting stronger with each kick. Brazilian female physiotherapist counts repetitions encouragingly. Camera side-on tracking the moving leg and determined face.`,
      `8-second shot: 9-year-old Brazilian child climbs therapy steps holding a rail, each step more confident than the last. Brazilian female physiotherapist watches from below nodding encouragingly. Camera low angle making child look powerful and improving.`,
      `8-second shot: 9-year-old Brazilian child walks the length of the clinic hallway this time without limping, upright and confident. Brazilian female physiotherapist watches with visible pride. Camera tracks from behind then swings to front to catch child's smile.`,
      `8-second shot: Brazilian female physiotherapist gives a high five to a 9-year-old child who just completed the session. Child's parent watches from doorway clapping. All three celebrate the visible progress together. Camera captures the warm genuine celebration.`
    ]
  },

  psicomotricidade: {
    estilo: `Bright colorful psychomotricity playroom, soft padded walls, foam mats, natural light, colorful cushions and equipment. Brazilian Latin features, warm brown skin. Light joyful documentary style, 24fps.`,
    cenas: [
      `8-second shot: 4-year-old Brazilian child runs excitedly into the bright colorful motor room, stops and stares wide-eyed at all the foam equipment. Brazilian female psychomotricist kneels down, opens arms in welcome, child runs toward her. Camera wide then push in.`,
      `8-second shot: 4-year-old Brazilian child rolls freely across a large colorful foam mat, laughing, hair flying. Brazilian female psychomotricist sits on mat nearby clapping and cheering. Camera follows in a smooth wide arc, capturing pure joyful movement.`,
      `8-second shot: 4-year-old Brazilian child jumps from a low soft platform onto a crash mat, lands in a heap, bounces up with arms raised in triumph. Brazilian female psychomotricist claps enthusiastically. Camera captures the arc of jump and joyful landing.`,
      `8-second shot: 4-year-old Brazilian child kicks and chases a large colorful ball around the room with growing coordination. Brazilian female psychomotricist kicks ball back gently, creating a playful exchange. Camera follows ball and laughing child dynamically.`,
      `8-second shot: 4-year-old Brazilian child crawls through a colorful fabric tunnel, pokes head out the far end with a huge surprised grin. Brazilian female psychomotricist waits at exit, celebrating the arrival with big smile. Camera at tunnel end captures the peek-out.`,
      `8-second shot: 4-year-old Brazilian child stands on a wobble board, arms out, tongue tip showing in concentration, finding balance; face shifts from uncertain to triumphant as balance holds. Brazilian female psychomotricist watches closely, ready but letting child succeed.`,
      `8-second shot: 4-year-old Brazilian child and Brazilian female psychomotricist paint freely with hands on a large paper on the floor — child fully immersed, laughing, making big expressive strokes. Camera overhead capturing pure creative motor expression.`,
      `8-second shot: 4-year-old Brazilian child spins freely in open space, arms wide, laughing with pure abandon, hair and clothes swirling. Brazilian female psychomotricist watches from the edge with a warm proud smile. Camera slowly orbits the spinning child.`
    ]
  },

  freio_lingual: {
    estilo: `Child-friendly pediatric dental clinic, soft warm lighting, cartoon animals painted on walls, colorful furniture. Brazilian Latin features, warm brown skin. Tender medical documentary style, 24fps.`,
    cenas: [
      `8-second shot: Young Brazilian mother carries a calm 14-month-old baby into a warm child-friendly dental clinic. Smiling Brazilian female receptionist waves hello at the baby; baby looks around curiously at the colorful animal decorations. Camera follows baby's wide-eyed gaze.`,
      `8-second shot: Brazilian female pediatric dentist enters the consultation room, crouches down to the 14-month-old baby's eye level, smiles very softly and makes gentle eye contact. Baby on mother's lap looks at the dentist with curious calm expression, not scared at all.`,
      `8-second shot: Brazilian mother holds calm 14-month-old baby securely on her lap. Brazilian female pediatric dentist gently opens baby's mouth and uses a gloved pinky finger to very softly touch inside; baby looks curious. Mother strokes baby's back reassuringly.`,
      `8-second shot: Brazilian female pediatric dentist points to a colorful educational poster showing a baby's mouth anatomy while explaining to the Brazilian mother. Mother listens attentively nodding while the 14-month-old baby plays with a colorful toy in her lap.`,
      `8-second shot: 14-month-old Brazilian baby sits contentedly on mother's lap playing with a bright rubber toy, completely relaxed. Brazilian female dentist prepares examination gently, speaking softly to mother. Camera holds on the peaceful trusting baby.`,
      `8-second shot: Brazilian female pediatric dentist very gently touches the 14-month-old baby's lower lip with a gloved finger; baby looks down at it with pure curiosity, then looks up at dentist with a small trusting expression. Mother smiles with visible relief.`,
      `8-second shot: 14-month-old Brazilian baby reaches out a tiny hand and lightly touches the Brazilian female dentist's gloved hand — a spontaneous moment of trust. Mother and dentist exchange a warm knowing look. Camera captures this touching moment of connection.`,
      `8-second shot: Brazilian female dentist hands printed aftercare instructions to the Brazilian mother; baby is in mother's arms happy and relaxed, playing with dentist's name badge. Mother smiles gratefully, dentist waves bye-bye at baby. Camera captures warm farewell.`
    ]
  },

  neuropsicologia: {
    estilo: `Cozy neuropsychology assessment office, warm amber lighting, colorful brain model on shelf, assessment materials on table. Brazilian Latin features, warm brown skin. Scientific documentary style, 24fps.`,
    cenas: [
      `8-second shot: 10-year-old Brazilian child enters assessment office, immediately notices a colorful brain model on the shelf and walks toward it with intense curiosity. Brazilian female neuropsychologist watches with a warm smile, letting the child explore freely.`,
      `8-second shot: Brazilian female neuropsychologist and 10-year-old Brazilian child play a visual memory card game, child flips cards with focus, trying to find pairs, face showing intense concentration. Camera close on hands flipping cards then on child's thinking face.`,
      `8-second shot: 10-year-old Brazilian child arranges colored blocks to match a pattern shown on a card, brow deeply furrowed, moving blocks methodically. Brazilian female neuropsychologist observes quietly without interfering. Camera overhead shows pattern emerging.`,
      `8-second shot: 10-year-old Brazilian child draws a figure of a person on assessment paper, tongue slightly out, completely absorbed in the task. Camera starts overhead then tilts to capture both the drawing and child's concentrated expression.`,
      `8-second shot: 10-year-old Brazilian child stares at an attention assessment worksheet, pencil poised, eyes scanning carefully down the page. Brazilian female neuropsychologist times the task quietly. Camera holds on child's intense focused expression.`,
      `8-second shot: 10-year-old Brazilian child's hands move a colorful puzzle piece around, trying different rotations, hesitates — then places it precisely in the correct spot. Child looks up with a proud concentrated smile. Brazilian female neuropsychologist nods approvingly.`,
      `8-second shot: 10-year-old Brazilian child uses a tablet for a cognitive assessment game, tapping carefully, Brazilian female neuropsychologist observes the screen data. Child's face shows full engagement. Camera alternates between screen and child's focused face.`,
      `8-second shot: Brazilian female neuropsychologist sits across from a parent and 10-year-old child, opening a results folder, explaining with warmth and clarity. Parent and child both lean forward nodding — faces showing understanding and relief.`
    ]
  },

  psicopedagogia: {
    estilo: `Colorful educational therapy room, warm window light, creative reading materials and letter boards on walls. Brazilian Latin features, warm brown skin. Inspiring educational documentary style, 24fps.`,
    cenas: [
      `8-second shot: 8-year-old Brazilian child sits at a therapy table surrounded by colorful books and learning materials. Brazilian female educational psychologist sits beside, opening a large illustrated book between them. Camera wide gently pushing in on the materials.`,
      `8-second shot: 8-year-old Brazilian child stares at a page of text with furrowed brows, lips moving silently, getting frustrated. Brazilian female educational psychologist leans in gently, pointing to the page with a colored ruler. Camera holds on child's struggling but trying face.`,
      `8-second shot: Brazilian female educational psychologist demonstrates a reading strategy using a colored transparent ruler under each line; 8-year-old child watches closely then tries it, eyes moving more easily across the page. Camera follows ruler and child's improving focus.`,
      `8-second shot: 8-year-old Brazilian child traces large printed letters on a textured board with their finger, saying each sound aloud. Brazilian female therapist guides the finger gently, confirming correct movements with encouraging nods. Camera close on tracing finger and face.`,
      `8-second shot: Brazilian female educational psychologist holds up word flash cards one by one; 8-year-old child squints hard at each, lips moving, working to decode syllables. Each word takes effort — camera captures the genuine struggle and persistence.`,
      `8-second shot: 8-year-old Brazilian child reads a sentence slowly aloud from the book — then pauses — then the eyes go wide and a HUGE smile breaks across the face — the breakthrough moment of full understanding. Camera pushes in slowly on this magical joyful face.`,
      `8-second shot: 8-year-old Brazilian child reads a full sentence aloud correctly and confidently. Brazilian female educational psychologist erupts in genuine enthusiastic applause; child looks amazed at their own success. Camera captures this high-energy celebration.`,
      `8-second shot: 8-year-old Brazilian child reads independently from a picture book, lips moving quietly, finger under words — no longer struggling, now flowing. Brazilian female therapist watches from a distance with visible quiet pride. Camera stays on the reading child.`
    ]
  },

  musicoterapia: {
    estilo: `Warm music therapy room, golden afternoon lighting, colorful instruments displayed on walls and shelves. Brazilian Latin features, warm brown skin. Magical therapeutic documentary style, 24fps.`,
    cenas: [
      `8-second shot: 6-year-old Brazilian child with autism carefully steps into the warm music therapy room and stops, eyes traveling slowly over the colorful instruments. Brazilian female music therapist stands back, giving the child space to absorb the environment at their own pace.`,
      `8-second shot: 6-year-old Brazilian child with autism tentatively reaches out and touches a large hand drum, taps it very softly once, jumps slightly at the sound, then looks at the Brazilian female music therapist — who smiles and nods encouragingly. Child taps again, more confident.`,
      `8-second shot: Brazilian female music therapist taps a simple rhythm on a small drum; 6-year-old child with autism watches, then slowly picks up a tambourine and copies the rhythm. Camera starts on drum then pulls back to reveal synchronized rhythmic exchange beginning.`,
      `8-second shot: 6-year-old Brazilian child with autism and Brazilian female music therapist tap percussion instruments together in synchronized rhythm, child fully engaged, both beginning to sway gently. Camera slowly moves in to capture the emerging genuine eye contact.`,
      `8-second shot: Brazilian female music therapist guides a 6-year-old child's fingers softly onto the keys of a small colorful keyboard; child presses a key, a note rings out. Child freezes, listens — then a slow smile forms. Camera captures this moment of sonic discovery.`,
      `8-second shot: Brazilian female music therapist sings a simple repetitive song with hand gestures; 6-year-old child with autism watches lips intently then begins humming along very softly. Camera close on child's face as the voice slowly and naturally emerges.`,
      `8-second shot: 6-year-old Brazilian child with autism shakes maracas freely and joyfully, laughing openly, whole body moving with the music. Brazilian female music therapist mirrors the child's movements. Camera captures the uninhibited shared joy and movement.`,
      `8-second shot: 6-year-old Brazilian child with autism spontaneously extends a small tambourine toward the Brazilian female music therapist — a genuine invitation to play together. Therapist accepts with a warm delighted smile. Camera holds on this tender moment of social initiation.`
    ]
  }
};

/**
 * Seleciona a cena correta para o clip atual com base no índice.
 * Usa modulo para ciclar se houver mais clips que cenas disponíveis.
 * @param {string} especialidade
 * @param {number} clipIndex - índice do clip (0-based)
 * @returns {string} prompt completo para o clip
 */
function buildScenePrompt(especialidade, clipIndex = 0) {
  const config = CENAS_ESPECIALIDADE[especialidade] || CENAS_ESPECIALIDADE.fonoaudiologia;
  const { cenas, estilo } = config;
  const cena = cenas[clipIndex % cenas.length];
  return `${cena} ${estilo}`;
}

/**
 * Template para tema personalizado — mantém estilo visual da especialidade.
 */
function buildCustomPrompt(tema, especialidade) {
  const config = CENAS_ESPECIALIDADE[especialidade] || CENAS_ESPECIALIDADE.fonoaudiologia;
  return `8-second single continuous shot: ${tema}. ${config.estilo}`;
}

export class VeoService {
  constructor() {
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_AI_API_KEY não configurado. Acesse aistudio.google.com para obter gratuitamente.');
    }
    this.ai = new GoogleGenAI({ apiKey });
  }

  /**
   * Gera vídeo com Google Veo 2.0
   * @param {string} especialidadeId - ID da especialidade
   * @param {string|null} temaCustom - Tema personalizado (opcional)
   * @param {Object} options
   * @param {number} options.durationSeconds - Duração (padrão: 8)
   * @param {string} options.aspectRatio - '9:16' para Reels/Stories
   * @param {number} options.clipIndex - Índice do clip (0-based) para variar cenas
   * @returns {{ url: string, duration: number, bytes: number }}
   */
  async gerarVideo(especialidadeId, temaCustom = null, options = {}) {
    const {
      durationSeconds = 8,
      aspectRatio = '9:16',
      clipIndex = 0
    } = options;

    const prompt = temaCustom
      ? buildCustomPrompt(temaCustom, especialidadeId)
      : buildScenePrompt(especialidadeId, clipIndex);

    logger.info(`[VEO SERVICE] 🎬 Iniciando geração — ${especialidadeId} — clip ${clipIndex + 1} — ${durationSeconds}s ${aspectRatio}`);
    logger.info(`[VEO SERVICE] Cena: ${prompt.substring(0, 120)}...`);

    let operation = await this.ai.models.generateVideos({
      model: 'veo-2.0-generate-001',
      prompt,
      config: {
        aspectRatio,
        durationSeconds,
        personGeneration: 'allow_all',
        numberOfVideos: 1
      }
    });

    // Polling até completar (~3-5 min)
    const MAX_WAIT_MS = 8 * 60 * 1000;
    const POLL_INTERVAL_MS = 15_000;
    const startTime = Date.now();

    while (!operation.done) {
      if (Date.now() - startTime > MAX_WAIT_MS) {
        throw new Error('[VEO SERVICE] Timeout: vídeo não gerado em 8 minutos');
      }
      logger.info(`[VEO SERVICE] ⏳ Aguardando geração... (~${Math.round((Date.now() - startTime) / 1000)}s)`);
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));

      // Retry no polling para tolerar erros de rede transitórios (WSL2 IPv6/IPv4)
      let pollTentativa = 0;
      while (true) {
        try {
          operation = await this.ai.operations.getVideosOperation({ operation });
          break;
        } catch (pollErr) {
          const isRede = pollErr?.message?.includes('fetch failed') || pollErr?.message?.includes('ECONNRESET') || pollErr?.message?.includes('ETIMEDOUT');
          if (isRede && pollTentativa < 4) {
            const waitMs = (pollTentativa + 1) * 5_000;
            logger.warn(`[VEO SERVICE] ⚠️ Erro de rede no polling (tentativa ${pollTentativa + 1}/4), aguardando ${waitMs / 1000}s...`);
            await new Promise(r => setTimeout(r, waitMs));
            pollTentativa++;
          } else {
            throw pollErr;
          }
        }
      }
    }

    if (operation.error) {
      throw new Error(`[VEO SERVICE] Erro da API Veo: ${operation.error.message}`);
    }

    const generatedVideo = operation.response?.generatedVideos?.[0];
    if (!generatedVideo?.video?.uri) {
      throw new Error('[VEO SERVICE] Nenhum vídeo retornado pela API');
    }

    logger.info(`[VEO SERVICE] ✅ Vídeo gerado! Baixando...`);

    // Download via axios com IPv4 (evita fetch failed no WSL2)
    const videoUri = generatedVideo.video.uri;
    const apiKey = process.env.GOOGLE_AI_API_KEY;
    const videoResponse = await axios.get(`${videoUri}&key=${apiKey}`, {
      responseType: 'arraybuffer',
      httpsAgent: ipv4HttpsAgent
    });

    // Salvar temporário
    const tempPath = path.join('/tmp', `veo_${Date.now()}.mp4`);
    fs.writeFileSync(tempPath, Buffer.from(videoResponse.data));

    // Upload para Cloudinary
    logger.info(`[VEO SERVICE] ☁️ Enviando para Cloudinary...`);
    const cloudinaryResult = await cloudinary.v2.uploader.upload(tempPath, {
      resource_type: 'video',
      folder: 'fono-inova/ai-videos/veo',
      public_id: `veo_${especialidadeId}_${Date.now()}`,
      overwrite: false
    });

    // Limpar arquivo temporário
    try { fs.unlinkSync(tempPath); } catch { /* ignora */ }

    logger.info(`[VEO SERVICE] 🎉 Sucesso! URL: ${cloudinaryResult.secure_url.substring(0, 60)}...`);

    return {
      url: cloudinaryResult.secure_url,
      duration: cloudinaryResult.duration || durationSeconds,
      bytes: cloudinaryResult.bytes,
      provider: 'veo-2.0'
    };
  }
}

/**
 * Verificar se Veo está configurado
 */
export function isVeoConfigured() {
  return Boolean(process.env.GOOGLE_AI_API_KEY);
}

export default VeoService;
