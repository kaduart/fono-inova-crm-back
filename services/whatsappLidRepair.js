// services/whatsappLidRepair.js
//
// Reparo de origens gravadas com o ID @lid no lugar do telefone. Idempotente: só toca em registro fora de
// /^55\d{10,11}$/ e só quando o WhatsApp resolve um número válido. A resolução vem de `resolveLids`:
// local (whatsapp-web.js) ou conector externo (POST /v1/contacts/resolve-lids). 18/11/2026: tirado do
// whatsappWebJsService sem mudar a regra.

/** @param {{ resolveLids: (lids: string[]) => Promise<Array<{ lid: string, phone: string|null }>> }} deps */
export async function repairLidAttributions({ resolveLids }) {
  if (process.env.WA_ATTRIBUTION_CAPTURE === 'false') return { fixed: 0, total: 0 };
  const LeadAttribution = (await import('../models/LeadAttribution.js')).default;
  const bad = await LeadAttribution.find({ phone: { $not: /^55\d{10,11}$/ } }).lean();
  if (!bad.length) return { fixed: 0, total: 0 };
  // normalizeE164BR prefixou "55" no lid: testa as duas formas.
  const candidatesOf = (a) => [a.phone, a.phone.startsWith('55') ? a.phone.slice(2) : null].filter(Boolean);
  const all = [...new Set(bad.flatMap(candidatesOf))];
  const resolved = new Map();
  for (const r of await resolveLids(all)) if (r?.phone && /^55\d{10,11}$/.test(r.phone)) resolved.set(String(r.lid), r.phone);
  let fixed = 0;
  for (const a of bad) {
    const pn = candidatesOf(a).map((c) => resolved.get(c)).find(Boolean);
    if (!pn) continue;
    if (await LeadAttribution.exists({ phone: pn })) await LeadAttribution.deleteOne({ _id: a._id }); // origem pelo número real prevalece
    else await LeadAttribution.updateOne({ _id: a._id }, { $set: { phone: pn } });
    fixed++;
  }
  console.log(`[WhatsAppWeb] 🔧 reparo @lid: ${fixed}/${bad.length} corrigidos`);
  return { fixed, total: bad.length };
}

export default { repairLidAttributions };
