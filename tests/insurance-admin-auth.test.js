// tests/insurance-admin-auth.test.js
// Valida o gap de auth corrigido em 2026-07-29 (investigação de arquitetura de convênio):
// /api/insurance/admin/convenios/* não tinha nenhuma checagem de token.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

describe('auth em /insurance/admin/convenios', () => {
    let app;
    let validToken;
    let hasRealAdmin = false;

    beforeAll(async () => {
        await import('../models/index.js');
        const insuranceRoutes = (await import('../domains/billing/insuranceRoutes.js')).default;
        app = express();
        app.use(express.json());
        app.use('/insurance', insuranceRoutes);

        const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
        if (mongoose.connection.readyState !== 1) {
            await mongoose.connect(uri);
        }
        const Admin = (await import('../models/Admin.js')).default;
        const admin = await Admin.findOne().select('_id').lean();
        if (admin) {
            hasRealAdmin = true;
            validToken = jwt.sign(
                { id: admin._id.toString(), role: 'admin' },
                process.env.JWT_SECRET || 'secreta',
                { expiresIn: '5m' }
            );
        }
    });

    afterAll(async () => {
        await mongoose.disconnect();
    });

    it('GET /admin/convenios sem token retorna 401 (não precisa de DB — corta antes)', async () => {
        const res = await request(app).get('/insurance/admin/convenios');
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('TOKEN_REQUIRED');
    });

    it('POST /admin/convenios sem token retorna 401', async () => {
        const res = await request(app)
            .post('/insurance/admin/convenios')
            .send({ code: 'teste', name: 'Teste', sessionValue: 100 });
        expect(res.status).toBe(401);
    });

    it('GET /admin/convenios com token inválido retorna 401', async () => {
        const res = await request(app)
            .get('/insurance/admin/convenios')
            .set('Authorization', 'Bearer token-invalido-nao-decodavel');
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('INVALID_TOKEN');
    });

    it('GET /admin/convenios com token válido não retorna 401 (passa da auth)', async () => {
        if (!hasRealAdmin) {
            console.warn('[skip] nenhum Admin encontrado no banco conectado — não dá pra validar o caminho "token válido"');
            return;
        }
        const res = await request(app)
            .get('/insurance/admin/convenios')
            .set('Authorization', `Bearer ${validToken}`);
        expect(res.status).not.toBe(401);
    });

    it('rota de lote (deprecated, sem CRUD) continua sem exigir auth — comportamento inalterado de propósito', async () => {
        const res = await request(app).get('/insurance/stats');
        expect(res.status).not.toBe(401);
    });
});
