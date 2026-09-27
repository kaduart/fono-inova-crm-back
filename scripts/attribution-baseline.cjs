// Baseline de atribuição (SOMENTE LEITURA). Rodar: node back/scripts/attribution-baseline.cjs
const P=require('path'); const back=P.resolve(__dirname,'..'); const root=P.resolve(back,'..');
const req=(m)=>{try{return require(P.join(back,'node_modules',m))}catch{return require(P.join(root,'node_modules',m))}};
req('dotenv').config({path:P.join(back,'.env')});
const mongoose=req('mongoose');
(async()=>{
 await mongoose.connect(process.env.MONGO_URI,{serverSelectionTimeoutMS:15000});
 const db=mongoose.connection.db;
 const since=new Date(Date.now()-30*864e5);
 const leads=db.collection('leads'), appts=db.collection('appointments');
 const total=await leads.countDocuments({createdAt:{$gte:since}});
 const bySrc=await leads.aggregate([{$match:{createdAt:{$gte:since}}},{$group:{_id:{src:'$metaTracking.source',origin:'$origin'},n:{$sum:1}}},{$sort:{n:-1}},{$limit:15}]).toArray();
 const withFb=await leads.countDocuments({createdAt:{$gte:since},'metaTracking.fbclid':{$nin:[null,'']}});
 const aTot=await appts.countDocuments({createdAt:{$gte:since}});
 const aFirst=await appts.countDocuments({createdAt:{$gte:since},$or:[{isFirstAppointment:true},{patientJourneyType:'new_patient'}]});
 const aLead=await appts.countDocuments({createdAt:{$gte:since},lead:{$ne:null}});
 const aSnap=await appts.countDocuments({createdAt:{$gte:since},'leadSnapshot.source':{$ne:null}});
 const sv=await appts.aggregate([{$match:{createdAt:{$gte:since},$or:[{isFirstAppointment:true},{patientJourneyType:'new_patient'}]}},{$group:{_id:'$serviceType',n:{$sum:1},avg:{$avg:'$sessionValue'}}}]).toArray();
 console.log(JSON.stringify({leads30d:total,withFbclid:withFb,bySrc,appts30d:aTot,firstAppts:aFirst,apptsWithLead:aLead,apptsWithSnapshot:aSnap,firstByService:sv},null,1));
 await mongoose.disconnect();
})().catch(e=>{console.error('ERR',e.message);process.exit(1)});
