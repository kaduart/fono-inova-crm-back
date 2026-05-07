import { describe, it, expect, vi, beforeEach } from 'vitest';

// Reproduz: [ALTO] sendTextMessage não tenta fallback VPS quando WhatsApp Web offline

vi.mock('../../services/whatsappWebJsService.js', () => ({
  getStatus: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock('../../services/whatsappVPSService.js', () => ({
  sendViaVPS: vi.fn(),
}));

vi.mock('../../models/Message.js', () => ({
  default: {
    create: vi.fn().mockResolvedValue({ _id: 'msg123' }),
  },
}));

vi.mock('../../models/Leads.js', () => ({
  default: {
    findById: vi.fn().mockResolvedValue(null),
    findByIdAndUpdate: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../../models/Contacts.js', () => ({
  default: {
    findOne: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../../config/socket.js', () => ({
  getIo: vi.fn(() => ({ emit: vi.fn() })),
}));

import { getStatus } from '../../services/whatsappWebJsService.js';
import { sendViaVPS } from '../../services/whatsappVPSService.js';
import { sendTextMessage } from '../../services/whatsappService.js';

describe('whatsappService — fallback VPS', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.VPS_WHATSAPP_URL;
    delete process.env.VPS_WHATSAPP_TOKEN;
  });

  it('deve lançar erro quando Web offline e VPS não configurado', async () => {
    getStatus.mockResolvedValue({ ready: false, status: 'qr' });

    await expect(
      sendTextMessage({ to: '61981694922', text: 'Oi' })
    ).rejects.toThrow('Escaneie o QR code');
  });

  it('deve fazer fallback VPS quando Web offline e VPS configurado', async () => {
    getStatus.mockResolvedValue({ ready: false, status: 'qr' });
    process.env.VPS_WHATSAPP_URL = 'https://vps.example.com';
    process.env.VPS_WHATSAPP_TOKEN = 'token123';
    sendViaVPS.mockResolvedValue({ messageId: 'vps_abc123' });

    const result = await sendTextMessage({
      to: '61981694922',
      text: 'Oi',
      lead: null,
      sentBy: 'manual',
    });

    expect(sendViaVPS).toHaveBeenCalledWith('5561981694922', 'Oi');
    expect(result._provider).toBe('vps');
    expect(result.messages[0].id).toBe('vps_abc123');
  });

  it('deve lançar erro detalhado quando VPS fallback também falha', async () => {
    getStatus.mockResolvedValue({ ready: false, status: 'disconnected' });
    process.env.VPS_WHATSAPP_URL = 'https://vps.example.com';
    process.env.VPS_WHATSAPP_TOKEN = 'token123';
    sendViaVPS.mockRejectedValue(new Error('VPS timeout'));

    await expect(
      sendTextMessage({ to: '61981694922', text: 'Oi' })
    ).rejects.toThrow(/VPS fallback falhou/);
  });
});
