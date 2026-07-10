/**
 * 🧪 Teste de integração - GET /api/reminders/:id
 *
 * Garante que o endpoint inexistente usado pelo frontend da Agenda Externa
 * para adiar lembretes agora responde corretamente.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import express from 'express';
import Reminder from '../../models/Reminder.js';
import reminderRouter from '../../routes/reminder.js';

describe('GET /api/reminders/:id', () => {
  let mongoServer;
  let app;
  const TEST_TOKEN = 'test-agenda-token';

  beforeAll(async () => {
    process.env.AGENDA_EXPORT_TOKEN = TEST_TOKEN;

    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());

    app = express();
    app.use(express.json());
    app.use('/api/reminders', reminderRouter);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  it('deve retornar 200 com o lembrete existente', async () => {
    const reminder = await Reminder.create({
      text: 'Lembrete de teste',
      dueDate: '2026-07-15',
      dueTime: '10:00',
      status: 'pending',
    });

    const res = await request(app)
      .get(`/api/reminders/${reminder._id}`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .expect(200);

    expect(res.body.text).toBe('Lembrete de teste');
    expect(res.body.status).toBe('pending');
    expect(new Date(res.body.dueDate).toISOString().startsWith('2026-07-15')).toBe(true);
  });

  it('deve retornar 404 para lembrete inexistente', async () => {
    const fakeId = new mongoose.Types.ObjectId();
    const res = await request(app)
      .get(`/api/reminders/${fakeId}`)
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .expect(404);

    expect(res.body.error).toContain('não encontrado');
  });

  it('deve retornar 400 para ID malformado', async () => {
    const res = await request(app)
      .get('/api/reminders/invalid-id')
      .set('Authorization', `Bearer ${TEST_TOKEN}`)
      .expect(400);

    expect(res.body.error).toBeDefined();
  });
});
