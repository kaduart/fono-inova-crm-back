import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Reproduz: [CRITICO] RemoteAuth sem clientId fixo → sessão não persiste
// Reproduz: [CRITICO] Graceful shutdown não destrói cliente → corrupção de sessão
// Reproduz: [ALTO] Reconexão duplicada em 'disconnected' → múltiplos clients

const LocalAuthMock = vi.fn().mockImplementation(function (opts) {
  this.opts = opts;
});
const ClientMock = vi.fn().mockImplementation(function () {
  this.destroy = vi.fn().mockResolvedValue(undefined);
  this.initialize = vi.fn().mockResolvedValue(undefined);
  this.on = vi.fn();
  this.info = { wid: { _serialized: '5561981694922@c.us' } };
});

vi.mock('whatsapp-web.js', () => ({
  default: {
    Client: ClientMock,
    LocalAuth: LocalAuthMock,
  },
}));

vi.mock('wwebjs-mongo', () => ({
  MongoStore: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

vi.mock('mongoose', () => ({
  default: {
    connection: {
      readyState: 1,
      once: vi.fn((event, cb) => { if (event === 'connected') cb(); }),
    },
  },
}));

vi.mock('../../models/WhatsAppWebState.js', () => ({
  default: {
    findOneAndUpdate: vi.fn().mockResolvedValue({}),
    findOne: vi.fn().mockResolvedValue(null),
  },
}));

vi.mock('../../services/setPuppeteerCache.js', () => ({}));

vi.mock('puppeteer', () => ({
  default: {
    executablePath: vi.fn(() => '/usr/bin/chrome'),
  },
}));

vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,abc'),
  },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: {
      ...actual.default,
      existsSync: vi.fn(() => true),
      mkdirSync: vi.fn(),
      readdirSync: vi.fn(() => []),
    },
  };
});

// 🔒 Mock do Redis para controlar lock deterministicamente
let lockHeld = false;
vi.mock('../../config/redisConnection.js', () => ({
  safeRedis: {
    set: vi.fn().mockImplementation(async () => {
      if (lockHeld) return null;
      lockHeld = true;
      return 'OK';
    }),
    del: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
  },
}));

describe('whatsappWebJsService — produção', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lockHeld = false; // reseta lock a cada teste
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('deve usar LocalAuth com dataPath /var/data/wwebjs_auth', async () => {
    const { initWhatsAppClient } = await import('../../services/whatsappWebJsService.js');
    await initWhatsAppClient();
    await new Promise((r) => setTimeout(r, 50));

    expect(LocalAuthMock).toHaveBeenCalled();
    const localAuthCall = LocalAuthMock.mock.calls[0][0];
    expect(localAuthCall).toHaveProperty('dataPath', '/var/data/wwebjs_auth');
  });

  it('watchdog: initialize() travado reinicia o Chrome em vez de ficar "Inicializando" para sempre', async () => {
    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {});
    try {
      ClientMock.mockImplementationOnce(function () {
        this.destroy = vi.fn().mockResolvedValue(undefined);
        this.initialize = vi.fn(() => new Promise(() => {})); // nunca resolve
        this.on = vi.fn();
      });
      const { initWhatsAppClient } = await import('../../services/whatsappWebJsService.js');
      initWhatsAppClient();
      await vi.advanceTimersByTimeAsync(1000);
      expect(exitSpy).not.toHaveBeenCalled();

      // No child (process.send existe), sai com 2 e o parent respawna Chrome novo com a sessão do disco
      await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
      expect(exitSpy).toHaveBeenCalledWith(2);
    } finally {
      exitSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('sessão já sincronizada sem ready: dispara o handler da lib (onAppStateHasSyncedEvent)', async () => {
    vi.useFakeTimers();
    try {
      const evaluate = vi.fn()
        .mockResolvedValueOnce({ state: 'CONNECTED', hasSynced: true, handler: 'function' })
        .mockResolvedValue(undefined);
      ClientMock.mockImplementationOnce(function () {
        this.destroy = vi.fn().mockResolvedValue(undefined);
        this.initialize = vi.fn().mockResolvedValue(undefined);
        this.on = vi.fn();
        this.pupPage = { evaluate, on: vi.fn() };
      });
      const { initWhatsAppClient } = await import('../../services/whatsappWebJsService.js');
      await initWhatsAppClient();
      await vi.advanceTimersByTimeAsync(5_500);
      expect(evaluate).toHaveBeenCalledTimes(2); // leitura do socket + kick
      expect(String(evaluate.mock.calls[1][0])).toContain('onAppStateHasSyncedEvent');
    } finally {
      vi.useRealTimers();
    }
  });

  it('deve chamar client.destroy() no graceful shutdown', async () => {
    const { initWhatsAppClient, gracefulShutdownWhatsApp } = await import('../../services/whatsappWebJsService.js');
    await initWhatsAppClient();
    await new Promise((r) => setTimeout(r, 50));

    expect(ClientMock).toHaveBeenCalled();
    const instance = ClientMock.mock.results[0].value;
    expect(instance).toBeDefined();

    await gracefulShutdownWhatsApp();
    expect(instance.destroy).toHaveBeenCalled();
  });

  it('deve evitar reconexão duplicada quando disconnected fire múltiplas vezes', async () => {
    const { initWhatsAppClient } = await import('../../services/whatsappWebJsService.js');
    await initWhatsAppClient();
    await new Promise((r) => setTimeout(r, 50));

    const instance = ClientMock.mock.results[0].value;
    const disconnectedHandler = instance.on.mock.calls.find((c) => c[0] === 'disconnected')?.[1];
    expect(disconnectedHandler).toBeDefined();

    // dispara disconnected duas vezes rapidamente
    await disconnectedHandler('network');
    await disconnectedHandler('network');

    // O segundo evento deve ter sido ignorado (isReconnecting = true).
    // Verificamos que destroy ainda não foi chamado porque o setTimeout
    // ainda não disparou (mínimo 5s), e não houve segunda chamada de
    // initWhatsAppClient (que criaria outro Client).
    expect(ClientMock).toHaveBeenCalledTimes(1);
  });
});
