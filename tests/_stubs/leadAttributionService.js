export async function getAttributionByPhone(p) { return (globalThis.__ATTR__ && globalThis.__ATTR__[p]) || null; }
export async function getAttributionsByPhones(phones = []) {
  const out = new Map();
  for (const p of phones) out.set(p, await getAttributionByPhone(p));
  return out;
}
export default { getAttributionByPhone, getAttributionsByPhones };
