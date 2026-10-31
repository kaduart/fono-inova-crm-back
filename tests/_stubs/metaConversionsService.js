export async function sendPurchaseToMeta(d) { return globalThis.__META__ ? globalThis.__META__(d) : undefined; }
export async function sendEventToMeta(d) { return sendPurchaseToMeta(d); }
export default { sendPurchaseToMeta, sendEventToMeta };
