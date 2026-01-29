db.payments.deleteMany({
  patient: ObjectId("6897dc360683ca3788ae815d")
});


db.appointments.deleteMany({
  patient: ObjectId("6897dc360683ca3788ae815d")
});
db.sessions.deleteMany({
  patient: ObjectId("6897dc360683ca3788ae815d")
});

// deletar por id
db.payments.deleteMany({
  _id: ObjectId("69178d81e34c6e12317aa044")
});

db.sessions.deleteMany({
  _id: ObjectId("69178d81e34c6e12317aa044")
});
db.appointments.deleteMany({
  _id: ObjectId("69178d81e34c6e12317aa048")
});

// atualiza dados do pagamento
db.payments.updateOne(
  { _id: ObjectId("68e3b5660d8aeeff1af03e3c") },
  { $set: { amount: 220, status: "paid" } }
);

db.appointments.deleteMany({
  patient: ObjectId("685c5617aec14c71635865ec"),
  operationalStatus: "cancelado"
});

db.payments.deleteMany({
  patient: ObjectId("685c5617aec14c71635865ec"),
  status: "canceled"
});

// deltar sessaos doctor
db.sessions.deleteMany({
  doctor: ObjectId("686024fb74dcf94b84ade15a"),
});
//consulta sessao por id
db.sessions.find({
  patient: ObjectId("68c029cecbdf4c1481b15592"),
});

//consulta pagamento por id patient
db.payments.find({
  patient: ObjectId("6979026c4b46e3fee85dc521"),
});

//consulta agendamento por  patient
db.appointments.find({
  patient: ObjectId("68ff61062d280f005fbd9bad"),
});
// conbsultar agednamenmto por id 
db.appointments.find({
  _id: ObjectId("685c2b78aec14c71635863bf"),
});

// consultar pagamentos do dia
db.payments.find({
  createdAt: {
    $gte: ISODate("2026-01-29T00:00:00.000Z"),
    $lt: ISODate("2026-01-30T00:00:00.000Z")
  }
})
/// atualizar pagamaneto por id
db.payments.updateOne(
  { _id: ObjectId("68fb8d1e2164a973dbbfa515") },
  { $set: { amount: 150 } }
)


db.payments.findOne({ _id: ISODate("68ff61082d280f005fbd9bb5") }, { status: 1, paymentMethod: 1 })

// consultar sessios do dia
db.sessions.find({
  createdAt: {
    $gte: ISODate("2025-10-17T00:00:00.000Z"),
    $lt: ISODate("2025-10-18T00:00:00.000Z")
  }
})
//consutla por ceratedat
db.appointments.find({
  createdAt: {
    $gte: ISODate("2025-10-27T00:00:00.000Z"),
    $lt: ISODate("2025-10-28T00:00:00.000Z")
  }
})

///follow-ups 
db.followups.find(
  {
    sentAt: {
      $gte: ISODate("2025-11-16T00:00:00.000Z"),
      $lt: ISODate("2025-11-17T00:00:00.000Z")
    }
  },
  {
    _id: 1,
    lead: 1,
    sentAt: 1,
    status: 1,
    message: 1,
    origin: 1
  }
).sort({ sentAt: 1 })

// busca apociente pe,o, nomee 
db.patients.find(
  { name: { $regex: "riiiiiiiiiiii", $options: "i" } }
).pretty()

///ouuuuu // Buscar agendamentos de hoje - 27/10/2025
db.packages.find({
  date: "2025-12-08"
}).sort({ time: 1 })

//agendamentos do dia 
db.appointments.find(
  { date: "2025-10-20" },
  { doctor: 1, time: 1, operationalStatus: 1, clinicalStatus: 1 }
)

// atendimento dooo dia 
db.payments.find({ serviceDate: "2025-11-18" }).sort({ paymentDate: 1 })
//pagamentos do dia 
db.payments.find({ paymentDate: "2025-11-18" }).sort({ serviceDate: 1 })


db.admins.findOne({
  email: "clinicafonoinova@gmail.com",
  role: "admin"
})

//consulta do dia futuro
db.appointments.find({
  serviceDate: "2025-08-29"
})

//consulta do dia futuro
db.packages.find({
  paymentDate: "2025-12-08"
})

// consulta do dia or doutor
db.appointments.find({
  doctor: ObjectId("684072213830f473da1b0b0b"),
  date: "2025-08-05",
  operationalStatus: { $ne: "cancelado" }
})


//consulta agendamento por id
db.payments.find({
  patient: ObjectId("6855c921c033e150e1dc6066"),
}).sort({ date: 1 }).limit(10).pretty()


/// criar agednaemnto na mao
db.appointments.insertOne({
  _id: ObjectId('686fd2039276a58116d07568'),
  patient: ObjectId('685c29afaec14c716358622a'),
  doctor: ObjectId('684072213830f473da1b0b0b'),
  date: ISODate('2025-07-22T18:00:00.000Z'),
  time: '02:40',
  operationalStatus: 'scheduled',
  clinicalStatus: 'pending',
  duration: 40,
  specialty: 'fonoaudiologia',
  history: [],
  createdAt: ISODate('2025-07-10T14:45:23.465Z'),
  updatedAt: ISODate('2025-07-10T14:52:58.430Z'),
  __v: 0,
  payment: ObjectId('68703164f4d174ee9016aaa6')
});


// Verificar sessões atualizadas
const updatedSessions = await Session.find({
  time: { $exists: true },
  updatedAt: { $gte: new Date(Date.now() - 60000) } // Último minuto
});

// Verificar sessões ainda sem time
const stillWithoutTime = await Session.countDocuments({
  time: { $exists: false }
});

//buscar pacote 

db.packages.deleteMany({
  status: "recovered",
});

//pacote por paciente 
db.packages.find({ patient: ObjectId("6897dc360683ca3788ae815d") }).pretty()

//mostra os detalhes do pacote
db.packages.find({ _id: ObjectId("6917c359d364f9d3b07bcbe9") }).pretty();

// deve retonrar qtd de sessoes do pacote
db.sessions.find({ package: ObjectId("68f682092286c73db5d29d38") }).count();

db.appointments.find({ package: ObjectId("68f6956de0e5b4debcb227e5") }).count();

db.appointments.find({ package: ObjectId("68f6956de0e5b4debcb227e5") }, { date: 1, paymentStatus: 1, operationalStatus: 1 }).pretty()

db.appointments.find(
  { package: ObjectId("68f6956de0e5b4debcb227e5") },
  { date: 1, status: 1, time: 1, operationalStatus: 1 }
).pretty();

//consultar sessoes do pacote
db.packages.find(
  { _id: { $in: [ObjectId("68eeb6f049e195b37058bb7f"), ObjectId("68eeb5f549e195b37058bab2")] } },
  { name: 1, sessionsDone: 1, "usage.sessions": { $slice: -3 } }
).pretty()

// diminuir qtd de sessoes do pacote
db.packages.updateOne(
  { _id: ObjectId("68eeb5f549e195b37058bab2") },
  [
    {
      $set: {
        sessionsDone: {
          $cond: [
            { $gt: ["$sessionsDone", 0] },
            { $subtract: ["$sessionsDone", 1] },
            0
          ]
        }
      }
    }
  ]
)

//doctos list
db.doctors.find(
  {}
).sort({ createdAt: -1 }).skip(0).limit(20);

//consultar todos agendamentos 
db.appointments.find(
  {}
).sort({ createdAt: -1 }).skip(0).limit(20);
//consultar todos pacietne 
db.patients.find(
  {}
).sort({ createdAt: -1 }).skip(0).limit(20);

// paciente por id
const id = ObjectId("686e7f2bb26f4da03d426e7b");
db.patients.findOne({ _id: id });


// 1️⃣ Deletar todas as mensagens do número
const phone = "556181694922";

db.contacts.deleteMany({ phone });
db.leads.deleteMany({ "contact.phone": phone });
db.messages.deleteMany({
  $or: [{ from: phone }, { to: phone }]
});


db.leads.findOne(
  { phone: "556181694922" },
  {
    name: 1,
    "qualificationData.extractedInfo": 1,
    "qualificationData.intent": 1,
    conversionScore: 1,
  }
);


db.followups.deleteMany({}); // se quiser zerar todos followups de teste


// cancelar followup
db.contacts.updateOne(
  { phone: "5561981694922" },
  {
    $set: {
      status: "agendado",          // ou "encerrado", como vocês usam
      stopAutomation: true,        // flag pra travar qualquer campanha
      updatedAt: new Date()
    }
  }
);


