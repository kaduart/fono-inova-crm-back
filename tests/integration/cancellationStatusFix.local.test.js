import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { classifyExistingCancellation } from '../../domain/appointment/historicalCancellationRules.js';
vi.mock('../../services/syncService.js', () => ({ syncEvent:async()=>{},handlePackageSessionUpdate:async()=>{} }));
vi.mock('../../services/appointment/helpers/socketHelper.js', () => ({ emitSocket:async()=>{} }));
vi.mock('../../services/auditLogService.js', () => ({ recordAudit:async()=>{} }));
vi.mock('../../routes/financialDashboard.v2.js', () => ({ invalidateDashboardCache:vi.fn(async()=>{}) }));
vi.mock('../../services/dailyClosingCacheService.js', () => ({ invalidateCacheForPayment:vi.fn(async()=>{}) }));
vi.mock('../../projections/paymentsProjection.js', () => ({ handlePaymentEvent:vi.fn(async()=>{}) }));
vi.mock('../../infrastructure/queue/queueConfig.js', () => ({ getQueue:()=>{throw Error('Publicação externa proibida');},closeQueues:async()=>{} }));
vi.mock('../../config/redisConnection.js', () => ({ redisConnection:null,bullMqConnection:null,safeRedis:{get:async()=>null,setex:async()=>null,del:async()=>null} }));
let server, Appointment, Session, Payment, Guide, Plan, Batch, Outbox, register, actor;
const oid = () => new mongoose.Types.ObjectId();
beforeAll(async()=>{
 server=await MongoMemoryReplSet.create({binary:{systemBinary:'C:/Users/User/.cache/mongodb-binaries/mongod-x64-win32-6.0.14.exe'},replSet:{count:1}});
 const uri=server.getUri();if(!uri.startsWith('mongodb://127.0.0.1:'))throw Error('Somente Mongo temporário local');
 await mongoose.connect(uri,{dbName:'test_cancellation_status_fix'});
 for(const name of ['Patient','Doctor','Package','User']) await import(`../../models/${name}.js`);
 Appointment=(await import('../../models/Appointment.js')).default;
 Session=(await import('../../models/Session.js')).default;
 Payment=(await import('../../models/Payment.js')).default;
 Guide=(await import('../../models/InsuranceGuide.js')).default;
 Plan=(await import('../../models/InsurancePlan.js')).default;
 Batch=(await import('../../models/InsuranceBatch.js')).default;
 Outbox=(await import('../../infrastructure/outbox/OutboxModel.js')).default;
 register=(await import('../../services/appointment/commands/registerCanceledInsuranceAppointmentsCommand.js')).registerCanceledInsuranceAppointments;
 actor={_id:oid(),role:'secretary'};
});
afterAll(async()=>{await mongoose.disconnect();if(server)await server.stop();});
async function seed(status='pre_agendado'){
 const patient=oid(),doctor=oid(),guide=oid(),plan=oid(),a=oid(),s=oid(),p=oid();
 await mongoose.model('Patient').collection.insertOne({_id:patient,fullName:'TESTE LOCAL'});
 await mongoose.model('Doctor').collection.insertOne({_id:doctor,fullName:'TESTE LOCAL',specialty:'terapia_ocupacional',email:String(doctor)+'@example.invalid',licenseNumber:String(doctor),phoneNumber:'00000000000'});
 await Guide.collection.insertOne({_id:guide,patientId:patient,specialty:'terapia_ocupacional',number:String(guide),insurance:'test',totalSessions:8,usedSessions:0,status:'active'});
 await Plan.collection.insertOne({_id:plan,patient,guide,doctor,specialty:'terapia_ocupacional',__v:0,generatedAppointments:[a]});
 await Appointment.collection.insertOne({_id:a,patient,doctor,insuranceGuide:guide,insurancePlan:plan,specialty:'terapia_ocupacional',sessionType:'terapia_ocupacional',date:new Date('2026-10-21T03:00Z'),time:'18:00',operationalStatus:status,clinicalStatus:status==='completed'?'completed':'pending',session:s,payment:p,billingType:'convenio',paymentMethod:'convenio',serviceType:'session',history:[],updatedAt:new Date()});
 await Session.collection.insertOne({_id:s,patient,doctor,appointmentId:a,insuranceGuide:guide,sessionType:'terapia_ocupacional',sessionValue:80,date:new Date('2026-10-21T03:00Z'),time:'18:00',status:status==='completed'?'completed':'scheduled',guideConsumed:false,sessionConsumed:false,paymentStatus:'pending_receipt'});
 await Payment.collection.insertOne({_id:p,patient,appointment:a,session:s,amount:0,paymentDate:new Date(),status:'pending',kind:'session_payment',billingType:'convenio',paymentMethod:'convenio',insurance:{status:'pending_billing',grossAmount:80},paidAt:null,financialDate:null});
 const row={specialty:'terapia_ocupacional',doctorId:String(doctor),date:'2026-10-21',time:'18:00',sessionValue:80,reason:'estava doente',cancelRequester:'professional'};
 return {patient,doctor,guide,plan,a,s,p,row,args:{planId:String(plan),cancellations:[row],dryRun:false,user:actor}};
}
describe('cancelamento de ocorrências existentes — transação Mongo local real',()=>{
 it.each(['pre_agendado','scheduled','confirmed'])('%s: preview sem escrita, aplicação coerente e replay sem duplicar',async status=>{
  const x=await seed(status),before=await Appointment.collection.findOne({_id:x.a});
  let result=await register({...x.args,dryRun:true});expect(result.conflicts).toEqual([]);expect(result.decisions[0].action).toBe('cancel');
  expect(await Appointment.collection.findOne({_id:x.a})).toEqual(before);
  result=await register(x.args);expect(result.canceled).toBe(1);expect(result.created).toBe(0);
  expect((await Appointment.findById(x.a)).operationalStatus).toBe('canceled');
  expect((await Session.findById(x.s)).status).toBe('canceled');expect((await Payment.findById(x.p)).status).toBe('canceled');
  expect((await Guide.findById(x.guide)).usedSessions).toBe(0);
  expect((await import('../../projections/paymentsProjection.js')).handlePaymentEvent).not.toHaveBeenCalled();
  expect((await import('../../services/dailyClosingCacheService.js')).invalidateCacheForPayment).not.toHaveBeenCalled();
  expect(await Appointment.countDocuments({patient:x.patient})).toBe(1);
  expect(await Session.countDocuments({patient:x.patient})).toBe(1);
  const counts={outbox:await Outbox.countDocuments(),history:(await Appointment.findById(x.a)).history.length};
  result=await register(x.args);expect(result.preserved).toBe(1);expect(result.canceled).toBe(0);
  expect(await Outbox.countDocuments()).toBe(counts.outbox);expect((await Appointment.findById(x.a)).history.length).toBe(counts.history);
 });
 it('concluído bloqueia o lote inteiro, inclusive outra ocorrência pendente',async()=>{
  const x=await seed('completed');
  const row2={...x.row,date:'2026-10-23',time:'15:20'};
  const r=await register({...x.args,cancellations:[x.row,row2]});
  expect(r.conflicts[0].code).toBe('COMPLETED_CANCELLATION_BLOCKED');
  expect((await Appointment.findById(x.a)).operationalStatus).toBe('completed');expect(await Appointment.countDocuments({patient:x.patient})).toBe(1);
 });
 it.each(['paid','billed','partial'])('financeiro %s bloqueia também a prévia',async status=>{
  const x=await seed();await Payment.collection.updateOne({_id:x.p},{$set:{status}});
  const r=await register({...x.args,dryRun:true});expect(r.conflicts[0].code).toBe('CANCELLATION_DEPENDENCY_BLOCKED');
  expect((await Appointment.findById(x.a)).operationalStatus).toBe('pre_agendado');
 });
 it('sessão consumida impede cancelar agendamento aparentemente pendente',async()=>{
  const x=await seed();await Session.collection.updateOne({_id:x.s},{$set:{guideConsumed:true}});
  const r=await register(x.args);expect(r.conflicts).toHaveLength(1);expect((await Guide.findById(x.guide)).usedSessions).toBe(0);
 });
 it('não cancela atendimento de outro plano',async()=>{
  const x=await seed();await Appointment.collection.updateOne({_id:x.a},{$set:{insurancePlan:oid()}});
  const r=await register(x.args);expect(r.conflicts[0].code).toBe('CANCELLATION_PLAN_MISMATCH');
 });
 it('cancelamento pendente não é habilitado implicitamente para Liminar',()=>{
  const row={specialty:'terapia_ocupacional',doctorId:'doctor'};
  expect(classifyExistingCancellation(row,[{_id:'a',operationalStatus:'scheduled',liminarContract:'c',specialty:row.specialty,doctor:'doctor'}],'c').action).toBe('conflict');
 });
 it('prévia da geração com transação externa pode abortar sem alterar documentos',async()=>{
  const x=await seed();const session=await mongoose.startSession();
  try {
   session.startTransaction();
   const result=await register({...x.args,mongoSession:session});expect(result.canceled).toBe(1);
   expect((await Appointment.findById(x.a).session(session)).operationalStatus).toBe('canceled');
   await session.abortTransaction();
   expect((await Appointment.findById(x.a)).operationalStatus).toBe('pre_agendado');
   expect((await Session.findById(x.s)).status).toBe('scheduled');
   expect((await Payment.findById(x.p)).status).toBe('pending');
   expect((await import('../../projections/paymentsProjection.js')).handlePaymentEvent).not.toHaveBeenCalled();
  } finally {await session.endSession();}
 });
 it('lote de faturamento bloqueia sem alterar a sessão',async()=>{
  const x=await seed();await Batch.collection.insertOne({status:'draft',sessions:[{appointment:x.a,session:x.s,payment:x.p}]});
  const result=await register(x.args);expect(result.conflicts).toHaveLength(1);
  expect((await Session.findById(x.s)).status).toBe('scheduled');
 });
 it('outra guia e múltiplas sessões não são corrigidas implicitamente',async()=>{
  const x=await seed();await Appointment.collection.updateOne({_id:x.a},{$set:{insuranceGuide:oid()}});
  expect((await register(x.args)).conflicts).toHaveLength(1);
  await Appointment.collection.updateOne({_id:x.a},{$set:{insuranceGuide:x.guide}});
  await Session.collection.insertOne({_id:oid(),appointmentId:x.a,status:'scheduled'});
  expect((await register(x.args)).conflicts[0].code).toBe('CANCELLATION_DEPENDENCY_BLOCKED');
 });
 it('falha ao gravar evento desfaz pagamento, sessão, agenda e versão do plano',async()=>{
  const x=await seed();const spy=vi.spyOn(Outbox.prototype,'save').mockRejectedValueOnce(new Error('evento falhou'));
  try {await expect(register(x.args)).rejects.toThrow('evento falhou');}
  finally {spy.mockRestore();}
  expect((await Appointment.findById(x.a)).operationalStatus).toBe('pre_agendado');
  expect((await Session.findById(x.s)).status).toBe('scheduled');
  expect((await Payment.findById(x.p)).status).toBe('pending');
  expect((await Plan.findById(x.plan)).__v).toBe(0);
 });
});
