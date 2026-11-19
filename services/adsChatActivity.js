// services/adsChatActivity.js
// Retomada dos leads de anúncio: confere no WhatsApp Web (SÓ LEITURA) quando foi a última mensagem
// da clínica e a do contato com cada telefone que chegou por anúncio. Não envia nada e não grava em
// lead/lista de espera: o resultado fica só no próprio WhatsAppScanRun (stats.rows).
// Fluxo: POST /api/whatsapp-web/ads-chat-activity → fila whatsapp-scan (adsActivity) → whatsapp-child.
import LeadAttribution from '../models/LeadAttribution.js';
import WhatsAppScanRun from '../models/WhatsAppScanRun.js';

const BRT_OFFSET_MS = 3 * 3600 * 1000;

/** 'YYYY-MM-DD' (Brasília) → Date do início do dia em UTC. */
export function startOfDayBRT(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]) + BRT_OFFSET_MS);
}

/** Telefones (só dígitos, únicos) que chegaram por anúncio a partir de `since`. */
export async function listAdPhones({ since }) {
    const rows = await LeadAttribution.find(
        { firstMessageAt: { $gte: since }, $or: [{ source: /_ads$/ }, { method: 'ctwa' }] },
        { phone: 1 },
    ).lean();
    return [...new Set(rows.map((r) => String(r.phone || '').replace(/\D/g, '')).filter((p) => p.length >= 10))];
}

/** Roda no whatsapp-child. `readChatActivity` vem do whatsappWebJsService. */
export async function runAdsChatActivity({ runId, readChatActivity }) {
    const run = await WhatsAppScanRun.findById(runId).select('phones').lean();
    const phones = run?.phones || [];
    const tails = new Set(phones.map((p) => String(p).slice(-8)));
    if (!tails.size) return { people: 0, chats: 0, withChat: 0, unresolved: 0, rows: [] };
    const res = await readChatActivity({ onlyTails: tails });
    const rows = res.rows
        .filter((r) => tails.has(String(r.phone).replace(/\D/g, '').slice(-8)))
        .map((r) => ({ phone: String(r.phone), clinicAt: r.clinicAt || null, contactAt: r.contactAt || null }));
    return { people: phones.length, chats: res.chats, withChat: rows.length, unresolved: res.unresolved, rows };
}
