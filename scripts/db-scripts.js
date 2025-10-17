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
  _id: ObjectId("68cc0b115cac66e0313cb3ca")
});
db.sessions.deleteMany({
  _id: ObjectId("68cc0b125cac66e0313cb3cd")
});
db.appointments.deleteMany({
  _id: ObjectId("68cc0b115cac66e0313cb3c8")
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
  patient: ObjectId("68e3b45a0d8aeeff1af03e1d"),
});


//consulta agendamento por  patient
db.appointments.find({
  patient: ObjectId("68f0ecb22de6dcb26c88a8e8"),
});
// conbsultar agednamenmto por id 
db.appointments.find({
  _id: ObjectId("685c2b78aec14c71635863bf"),
});

// consultar pagamentos do dia
db.payments.find({
  createdAt: {
    $gte: ISODate("2025-10-16T00:00:00.000Z"),
    $lt: ISODate("2025-10-17T00:00:00.000Z")
  }
})

// consultar sessios do dia
db.sessions.find({
  createdAt: {
    $gte: ISODate("2025-08-18T00:00:00.000Z"),
    $lt: ISODate("2025-08-18T23:59:00.000Z")
  }
})
//consutla por ceratedat
db.payments.find({
  createdAt: {
    $gte: ISODate("2025-08-29T00:00:00.000Z"),
    $lt: ISODate("2025-08-29T23:59:00.000Z")
  }
})

db.admins.findOne({
  email: "clinicafonoinova@gmail.com",
  role: "admin"
})

//consulta do dia futuro
db.appointments.find({
  serviceDate: "2025-08-29"
})

//consulta do dia futuro
db.payments.find({
  date: "2025-08-29"
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