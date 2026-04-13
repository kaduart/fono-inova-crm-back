/**
 * utils/whatsappFormatter.js
 *
 * Normaliza o texto gerado pela IA (Amanda / orchestrator)
 * antes de enviar ao WhatsApp.
 *
 * Extraído de whatsappController.js (inline) → util reutilizável.
 */

export function formatWhatsAppResponse(text) {
    if (!text || typeof text !== 'string') return '';

    return text
        .trim()
        // Remove múltiplas quebras consecutivas → máx 2
        .replace(/\n{3,}/g, '\n\n')
        // Adiciona quebra dupla entre fim de frase e início de nova (melhora leitura no celular)
        .replace(/([.!?])([A-Z][a-z])/g, '$1\n\n$2')
        // Garante espaçamento antes de bullets/listas
        .replace(/([^\n])(\n[•\-*]\s)/g, '$1\n$2')
        // Remove espaços duplos
        .replace(/[ \t]{2,}/g, ' ')
        // Remove caracteres invisíveis gerados por LLMs (zero-width spaces, BOM)
        .replace(/[\u200B-\u200D\uFEFF]/g, '')
        // Remove espaços no fim de cada linha
        .split('\n').map(line => line.trimEnd()).join('\n')
        // Limite seguro WhatsApp (max 4096 chars, 3500 deixa margem para templates)
        .slice(0, 3500);
}
