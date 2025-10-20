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
  _id: ObjectId("68f26a8ec5bd0b3e3273e1e3")
});
db.sessions.deleteMany({
  _id: ObjectId("68f24da3dbd680a8e1f108e7")
});
db.appointments.deleteMany({
  _id: ObjectId("68ed08d59a37fc7155f8aeb7")
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
  patient: ObjectId("68e7ed7b08b71f599ddc37e6"),
});
// conbsultar agednamenmto por id 
db.appointments.find({
  _id: ObjectId("685c2b78aec14c71635863bf"),
});

// consultar pagamentos do dia
db.payments.find({
  createdAt: {
    $gte: ISODate("2025-10-20T00:00:00.000Z"),
    $lt: ISODate("2025-10-21T00:00:00.000Z")
  }
})

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
    $gte: ISODate("2025-10-20T00:00:00.000Z"),
    $lt: ISODate("2025-10-21T00:00:00.000Z")
  }
})

//agendamentos do dia 
db.appointments.find(
  { date: "2025-10-20" },
  { doctor: 1, time: 1, operationalStatus: 1, clinicalStatus: 1 }
)


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

//pacote por paciente 
db.packages.find({ patient: ObjectId("6897dc360683ca3788ae815d") }).pretty()

//mostra os detalhes do pacote
db.packages.find({ _id: ObjectId("68f682092286c73db5d29d38") }).pretty();
// deve retonrar qtd de sessoes do pacote
db.sessions.find({ package: ObjectId("68f682092286c73db5d29d38") }).count();

db.appointments.find({ package: ObjectId("68f6956de0e5b4debcb227e5") }).count();

db.appointments.find({ package: ObjectId("68f6956de0e5b4debcb227e5") }, { date: 1, paymentStatus: 1, operationalStatus: 1 }).pretty()

db.appointments.find(
  { package: ObjectId("68f6956de0e5b4debcb227e5") },
  { date: 1, status: 1, time: 1, operationalStatus: 1 }
).pretty();
