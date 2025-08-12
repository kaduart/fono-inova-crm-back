db.payments.deleteMany({
  patient: ObjectId("6897dc360683ca3788ae815d")
});
db.payments.deleteMany({
  _id: ObjectId("6899df06c1f2dc889a764bb7")
});

db.appointments.deleteMany({
  patient: ObjectId("6897dc360683ca3788ae815d")
});
db.sessions.deleteMany({
  patient: ObjectId("6897dc360683ca3788ae815d")
});


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
  patient: ObjectId("685c29afaec14c716358622a"),
});

//consulta pagamento por id patient
db.payments.find({
  patient: ObjectId("685c5617aec14c71635865ec"),
});


//consulta agendamento por id patient
db.appointments.find({
  _id: ObjectId("6893c50f4b4ab2f2fe938218"),
});

// consultar pagamentos do dia
db.payments.find({
  createdAt: {
    $gte: ISODate("2025-08-11T00:00:00.000Z"),
    $lt: ISODate("2025-08-12T00:00:00.000Z")
  }
})

// consultar sessios do dia
db.sessions.find({
  createdAt: {
    $gte: ISODate("2025-08-14T00:00:00.000Z"),
    $lt: ISODate("2025-08-14T23:59:00.000Z")
  }
})

//consulta do dia futuro
db.appointments.find({
  date: "2025-08-11"
})

//consulta do dia futuro
db.payments.find({
  date: "2025-08-14"
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
  operationalStatus: 'agendado',
  clinicalStatus: 'pendente',
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