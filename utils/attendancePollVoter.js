const isRealBRPhone = (value) => /^55\d{10,11}$/.test(String(value || '').replace(/\D/g, ''));

export async function resolveAttendancePollVoterPhone(vote, activeClient) {
  const voter = vote?.voter?._serialized || vote?.voter || '';
  const serialized = String(voter);

  if (serialized.endsWith('@c.us')) {
    return serialized.replace('@c.us', '');
  }

  if (!serialized.endsWith('@lid') || !activeClient) return null;

  try {
    if (activeClient.getContactLidAndPhone) {
      const result = await activeClient.getContactLidAndPhone([serialized]);
      const phone = String(result?.[0]?.pn || '').replace(/@.*$/, '');
      if (isRealBRPhone(phone)) return phone;
    }
  } catch (err) {
    console.warn('[WhatsAppWeb] ⚠️ falha ao resolver votante @lid:', err?.message);
  }

  try {
    const phone = await activeClient.pupPage?.evaluate((lid) => {
      const contact = window.Store?.Contact?.get?.(lid);
      return contact?.phoneNumber?.user || null;
    }, serialized);
    if (isRealBRPhone(phone)) return phone;
  } catch (err) {
    console.warn('[WhatsAppWeb] ⚠️ fallback Store para votante @lid falhou:', err?.message);
  }

  return null;
}

export default resolveAttendancePollVoterPhone;
