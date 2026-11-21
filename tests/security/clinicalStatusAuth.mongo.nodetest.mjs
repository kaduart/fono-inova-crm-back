// Reprodução local da auditoria "status clínico" e de um achado novo na troca de
// senha. Só dados fictícios, Mongo e Redis de loopback.
//
//   MONGO_TEST_URI='mongodb://127.0.0.1:27217/?directConnection=true' REDIS_URL=redis://127.0.0.1:6479 \
//     node --experimental-test-module-mocks --test --test-force-exit tests/security/clinicalStatusAuth.mongo.nodetest.mjs
//
// Cada teste descreve o comportamento CORRETO. Os que falham antes da correção
// são a prova da brecha; depois da correção todos passam.
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

const URI = process.env.MONGO_TEST_URI;
const loop = (u) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(u).hostname);
const skip = !URI || !process.env.REDIS_URL ? 'MONGO_TEST_URI e REDIS_URL (loopback) necessários' : false;
if (URI && !loop(URI)) throw new Error('MONGO_TEST_URI precisa ser loopback');
if (process.env.REDIS_URL && !loop(process.env.REDIS_URL)) throw new Error('REDIS_URL precisa ser loopback');

process.env.JWT_SECRET = 'segredo-de-teste-ficticio';
process.env.ADMIN_API_TOKEN = 'token-amanda-ficticio';

// Nenhum e-mail sai do teste: o envio é trocado por um registro em memória.
const emails = [];
mock.module('../../services/emailService.js', {
  namedExports: { sendPasswordResetEmail: async (m) => { emails.push(m); } },
});

let app;
const id = {};
const tok = {};
const sign = (sub, role) => jwt.sign({ id: String(sub), role }, process.env.JWT_SECRET, { expiresIn: '5m' });
const patch = (path, t, body) => {
  const r = request(app).patch(path).send(body);
  if (t) r.set('Authorization', `Bearer ${t}`);
  return r.timeout({ response: 10000 });
};
const clinical = (appt, t, status = 'in_progress') => patch(`/api/v2/appointments/${appt}/clinical-status`, t, { status });
const statusOf = async (appt) =>
  (await mongoose.connection.db.collection('appointments').findOne({ _id: appt }))?.clinicalStatus;

before(async () => {
  if (skip) return;
  await mongoose.connect(URI, { dbName: `crm_seg_status_${Date.now()}` });
  const oid = () => new mongoose.Types.ObjectId();
  Object.assign(id, { admin: oid(), sec: oid(), docA: oid(), docB: oid(), patient: oid(), apptA: oid(), apptSemProf: oid() });
  const db = mongoose.connection.db;
  await db.collection('admins').insertMany([
    { _id: id.admin, name: 'Admin Ficticio', fullName: 'Admin Ficticio', email: 'admin@teste.invalid', role: 'admin' },
    { _id: id.sec, name: 'Secretaria Ficticia', fullName: 'Secretaria Ficticia', email: 'sec@teste.invalid', role: 'secretary' },
  ]);
  await db.collection('doctors').insertMany([
    { _id: id.docA, fullName: 'Dra A Ficticia', email: 'a@teste.invalid', role: 'doctor', active: true, specialty: 'fonoaudiologia', licenseNumber: 'FICT-A', phoneNumber: '00000000000' },
    { _id: id.docB, fullName: 'Dr B Ficticio', email: 'b@teste.invalid', role: 'doctor', active: true },
  ]);
  await db.collection('patients').insertOne({ _id: id.patient, fullName: 'Paciente Ficticio', dateOfBirth: new Date('2018-01-01') });
  const base = { patient: id.patient, date: new Date(), time: '09:00', operationalStatus: 'scheduled', clinicalStatus: 'pending', history: [] };
  await db.collection('appointments').insertMany([
    { _id: id.apptA, doctor: id.docA, ...base },
    { _id: id.apptSemProf, ...base },
  ]);
  tok.admin = sign(id.admin, 'admin');
  tok.sec = sign(id.sec, 'secretary');
  tok.docA = sign(id.docA, 'doctor');
  tok.docB = sign(id.docB, 'doctor');

  app = express();
  app.use(express.json());
  for (const [p, file] of [
    ['/api/signup', '../../routes/signup.js'],
    ['/api/login', '../../routes/login.js'],
    ['/api/auth', '../../routes/auth.js'],
    ['/api/v2/appointments', '../../routes/appointment.v2.js'],
  ]) app.use(p, (await import(file)).default);
});

after(async () => {
  if (skip) return;
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
});

test('C1 sem token não muda status clínico', { skip }, async () => {
  const r = await clinical(id.apptA, null);
  assert.equal(r.status, 401);
});

test('C2 paciente do cadastro público não muda status clínico', { skip }, async () => {
  const email = `paciente-${Date.now()}@teste.invalid`;
  const s = await request(app).post('/api/signup').send({ fullName: 'Pessoa Ficticia', email, password: 'senha-ficticia-123' });
  assert.equal(s.status, 201, `cadastro: ${s.status}`);
  const l = await request(app).post('/api/login').send({ email, password: 'senha-ficticia-123', role: 'patient' });
  assert.equal(l.status, 200, `login: ${l.status}`);
  const r = await clinical(id.apptA, l.body.token);
  assert.ok([401, 403].includes(r.status), `paciente: veio ${r.status}`);
  assert.equal(await statusOf(id.apptA), 'pending');
});

test('C3 profissional não muda status de atendimento de outro profissional', { skip }, async () => {
  const r = await clinical(id.apptA, tok.docB);
  assert.equal(r.status, 403, `docB: veio ${r.status}`);
  assert.equal(await statusOf(id.apptA), 'pending');
});

test('C4 profissional muda o próprio atendimento (não pode quebrar)', { skip }, async () => {
  const r = await clinical(id.apptA, tok.docA);
  assert.equal(r.status, 200, `docA: veio ${r.status}`);
  assert.equal(await statusOf(id.apptA), 'in_progress');
});

test('C5 secretaria e admin mudam qualquer atendimento (não pode quebrar)', { skip }, async () => {
  assert.equal((await clinical(id.apptA, tok.sec, 'pending')).status, 200);
  assert.equal((await clinical(id.apptA, tok.admin, 'pending')).status, 200);
});

test('C6 profissional não muda atendimento sem profissional definido', { skip }, async () => {
  const r = await clinical(id.apptSemProf, tok.docB);
  assert.equal(r.status, 403, `atendimento sem profissional: veio ${r.status}`);
  assert.equal(await statusOf(id.apptSemProf), 'pending');
});

test('C7 token de serviço (ADMIN_API_TOKEN) não muda status clínico', { skip }, async () => {
  const r = await clinical(id.apptA, process.env.ADMIN_API_TOKEN);
  assert.equal(r.status, 401, `token de serviço: veio ${r.status}`);
});

test('C8 secretária que redefine a senha não recebe token de admin', { skip }, async () => {
  const raw = crypto.randomBytes(32).toString('hex');
  await mongoose.connection.db.collection('admins').updateOne({ _id: id.sec }, {
    $set: { passwordResetToken: crypto.createHash('sha256').update(raw).digest('hex'), passwordResetExpires: new Date(Date.now() + 6e5) },
  });
  const r = await patch(`/api/auth/reset-password/${raw}`, null, { password: 'nova-senha-ficticia', role: 'admin' });
  if (r.status === 200) {
    const role = jwt.decode(r.body.token)?.role;
    assert.equal(role, 'secretary', `token emitido com papel ${role}`);
  } else {
    assert.equal(r.status, 400, `troca de senha: veio ${r.status}`);
  }
});

test('C9 sem login, só com o e-mail, ninguém troca a senha do admin', { skip }, async () => {
  const r = await request(app).post('/api/auth/forgot/manual').send({ email: 'admin@teste.invalid', role: 'admin' });
  const token = String(r.body?.resetUrl || '').match(/[0-9a-f]{64}/)?.[0];
  if (!token) return; // corrigido: a resposta não entrega link utilizável
  const reset = await patch(`/api/auth/reset-password/${token}`, null, { password: 'senha-do-atacante', role: 'admin' });
  assert.notEqual(reset.status, 200, `senha do admin trocada sem login; token com papel ${jwt.decode(reset.body?.token || '')?.role}`);
});

test('C10 admin logado ainda gera link de redefinição para a equipe (não pode quebrar)', { skip }, async () => {
  const r = await request(app).post('/api/auth/forgot/manual').set('Authorization', `Bearer ${tok.admin}`)
    .send({ email: 'a@teste.invalid', role: 'doctor' });
  assert.equal(r.status, 200, `admin: veio ${r.status}`);
  const token = String(r.body?.resetUrl || '').match(/[0-9a-f]{64}/)?.[0];
  assert.ok(token, 'admin deveria receber o link');
  const reset = await patch(`/api/auth/reset-password/${token}`, null, { password: 'nova-senha-ficticia', role: 'doctor' });
  assert.equal(reset.status, 200, `troca: veio ${reset.status}`);
  assert.equal(jwt.decode(reset.body.token).role, 'doctor');
});

test('C11 sem login, o pedido de redefinição vai por e-mail e a resposta não traz link', { skip }, async () => {
  emails.length = 0;
  const r = await request(app).post('/api/auth/forgot/manual').send({ email: 'b@teste.invalid', role: 'doctor' });
  assert.equal(r.status, 200, `veio ${r.status}`);
  assert.equal(r.body?.resetUrl, undefined, 'a resposta não pode trazer o link');
  assert.equal(emails.length, 1, 'o link deveria ir por e-mail');
  assert.equal(emails[0].email, 'b@teste.invalid');
});

test('C12 token de admin emitido para uma secretária é recusado no backend', { skip }, async () => {
  const forjado = sign(id.sec, 'admin');
  const r = await clinical(id.apptA, forjado);
  assert.equal(r.status, 401, `token de admin da secretária: veio ${r.status}`);
  const renov = await request(app).post('/api/login/renew-token').set('Authorization', `Bearer ${forjado}`);
  assert.equal(renov.status, 401, `renovação: veio ${renov.status}`);
});

test('C13 rotas com flexibleAuth também recusam token de admin emitido para secretária', { skip }, async () => {
  const forjado = sign(id.sec, 'admin');
  const r = await patch(`/api/v2/appointments/${id.apptA}/confirm`, forjado, {});
  assert.equal(r.status, 401, `flexibleAuth com token forjado: veio ${r.status}`);
});
