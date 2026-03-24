/**
 * 🎬 Preset Service - Configurações Premium para Vídeos Fono Inova
 * 
 * Fornece configurações otimizadas de TTS, música e VEO baseadas em estratégia de conteúdo.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Carrega presets do JSON
const presetsPath = path.join(__dirname, '../../config/video-presets-premium.json');
let presetsCache = null;

function loadPresets() {
  if (presetsCache) return presetsCache;
  try {
    const data = fs.readFileSync(presetsPath, 'utf8');
    presetsCache = JSON.parse(data);
    return presetsCache;
  } catch (err) {
    console.error('[PRESET SERVICE] Erro ao carregar presets:', err.message);
    return null;
  }
}

/**
 * Obtém configuração completa de um preset
 * @param {string} presetName - Nome do preset: 'explosao_viral', 'autoridade_inspiradora', 'empatia_emocional', 'alerta_urgencia', 'erro_correcao'
 * @returns {Object|null} Configuração completa do preset
 */
export function getPreset(presetName) {
  const presets = loadPresets();
  if (!presets || !presets.presets[presetName]) {
    console.warn(`[PRESET SERVICE] Preset '${presetName}' não encontrado`);
    return null;
  }
  return presets.presets[presetName];
}

/**
 * Lista todos os presets disponíveis
 * @returns {Array} Lista de presets com nome e descrição
 */
export function listPresets() {
  const presets = loadPresets();
  if (!presets) return [];
  
  return Object.entries(presets.presets).map(([key, value]) => ({
    id: key,
    nome: value.nome,
    objetivo: value.objetivo,
    ideal_para: value.ideal_para,
    duracao_recomendada: value.duracao_recomendada
  }));
}

/**
 * Obtém configuração de TTS otimizada para um preset
 * @param {string} presetName 
 * @returns {Object} Configuração TTS: { voice, speed, tom }
 */
export function getTTSConfig(presetName) {
  const preset = getPreset(presetName);
  if (!preset) {
    // Fallback seguro
    return { voice: 'nova', speed: 1.0, tom: 'neutro' };
  }
  return {
    voice: preset.tts.voz,
    speed: preset.tts.velocidade,
    tom: preset.tts.tom,
    pausas: preset.tts.pausas
  };
}

/**
 * Obtém configuração de música otimizada para um preset
 * @param {string} presetName 
 * @returns {Object} Configuração música: { volume, fadeIn, tipo }
 */
export function getMusicConfig(presetName) {
  const preset = getPreset(presetName);
  if (!preset) {
    return { volume: 0.08, fadeIn: 1.5, tipo: 'padrao' };
  }
  return {
    volume: preset.musica.volume,
    fadeIn: preset.musica.fade_in,
    tipo: preset.musica.tipo,
    arquivosSugeridos: preset.musica.arquivos_sugeridos
  };
}

/**
 * Obtém configuração de VEO otimizada para um preset
 * @param {string} presetName 
 * @returns {Object} Configuração VEO: { intensidade, modificadores, estiloVisual }
 */
export function getVEOConfig(presetName) {
  const preset = getPreset(presetName);
  if (!preset) {
    return { intensidade: 'moderado', modificadores: '', estiloVisual: 'documentary' };
  }
  return {
    intensidade: preset.veo.intensidade,
    modificadores: preset.veo.modificadores,
    duracaoClip: preset.veo.duracao_clip,
    estiloVisual: preset.veo.estilo_visual
  };
}

/**
 * Obtém sugestão de hook para um preset
 * @param {string} presetName 
 * @param {number} index - Índice do hook (opcional, para variação)
 * @returns {string} Texto do hook
 */
export function getHookSuggestion(presetName, index = 0) {
  const preset = getPreset(presetName);
  if (!preset || !preset.hook.exemplos.length) {
    return '';
  }
  const hooks = preset.hook.exemplos;
  return hooks[index % hooks.length];
}

/**
 * Obtém sugestão de CTA para um preset
 * @param {string} presetName 
 * @param {number} index - Índice do CTA (opcional)
 * @returns {string} Texto do CTA
 */
export function getCTASuggestion(presetName, index = 0) {
  const preset = getPreset(presetName);
  if (!preset || !preset.cta.textos.length) {
    return '';
  }
  const ctas = preset.cta.textos;
  return ctas[index % ctas.length];
}

/**
 * Obtém template de script completo para um preset
 * @param {string} presetName 
 * @returns {Object} Template com estrutura e exemplo
 */
export function getScriptTemplate(presetName) {
  const preset = getPreset(presetName);
  if (!preset) return null;
  
  return {
    estrutura: preset.script_template.estrutura,
    palavrasRecomendadas: preset.script_template.palavras_recomendadas,
    exemplo: preset.script_template.exemplo_completo
  };
}

/**
 * Mapeia hookStyle + tone + intensidade para o melhor preset
 * @param {string} hookStyle - 'curiosidade', 'dor', 'alerta', 'autoridade', 'erro_comum'
 * @param {string} tone - 'emotional', 'educativo', 'inspiracional', 'bastidores'
 * @param {string} intensidade - 'leve', 'moderado', 'forte', 'viral'
 * @returns {string} Nome do preset recomendado
 */
export function recommendPreset(hookStyle, tone, intensidade) {
  const map = {
    // hookStyle + tone + intensidade -> preset
    'curiosidade+emotional+viral': 'explosao_viral',
    'curiosidade+emotional+forte': 'explosao_viral',
    'curiosidade+educativo+viral': 'explosao_viral',
    'autoridade+inspiracional+viral': 'autoridade_inspiradora',
    'autoridade+inspiracional+forte': 'autoridade_inspiradora',
    'autoridade+bastidores+viral': 'autoridade_inspiradora',
    'dor+emotional+forte': 'empatia_emocional',
    'dor+emotional+viral': 'empatia_emocional',
    'dor+emotional+moderado': 'empatia_emocional',
    'alerta+inspiracional+forte': 'alerta_urgencia',
    'alerta+inspiracional+viral': 'alerta_urgencia',
    'alerta+educativo+forte': 'alerta_urgencia',
    'erro_comum+educativo+moderado': 'erro_correcao',
    'erro_comum+educativo+forte': 'erro_correcao',
  };
  
  const key = `${hookStyle}+${tone}+${intensidade}`;
  return map[key] || 'explosao_viral'; // Default seguro
}

/**
 * Obtém todas as configurações combinadas para produção
 * @param {string} presetName 
 * @returns {Object} Configuração completa para o worker
 */
export function getFullProductionConfig(presetName) {
  const preset = getPreset(presetName);
  if (!preset) return null;
  
  return {
    nome: preset.nome,
    objetivo: preset.objetivo,
    idealPara: preset.ideal_para,
    duracaoRecomendada: preset.duracao_recomendada,
    tts: getTTSConfig(presetName),
    musica: getMusicConfig(presetName),
    veo: getVEOConfig(presetName),
    hook: getHookSuggestion(presetName),
    cta: getCTASuggestion(presetName),
    scriptTemplate: getScriptTemplate(presetName),
    estrutura: preset.script_template.estrutura
  };
}

// Exporta configurações globais (cores, fontes, etc.)
export function getGlobalConfig() {
  const presets = loadPresets();
  return presets?.configuracoes_globais || null;
}

export default {
  getPreset,
  listPresets,
  getTTSConfig,
  getMusicConfig,
  getVEOConfig,
  getHookSuggestion,
  getCTASuggestion,
  getScriptTemplate,
  recommendPreset,
  getFullProductionConfig,
  getGlobalConfig
};
