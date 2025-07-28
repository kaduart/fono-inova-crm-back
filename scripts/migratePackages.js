scripts para executar no bd

1 - mongosh "mongodb+srv://kaduart:@Soundcar10@cluster0.g2c3sdk.mongodb.net/test" --username kaduart

db.getCollectionNames().forEach(coll => {
  if (db[coll].findOne({ doctorId: { $exists: true } })) {
    db[coll].updateMany(
      { doctorId: { $exists: true } },
      { $rename: { doctorId: "doctor" } }
    );
    print(`Coleção ${coll}: doctorId → doctor`);
  }
});

db.getCollectionNames().forEach(coll => {
  if (db[coll].findOne({ patientId: { $exists: true } })) {
    db[coll].updateMany(
      { patientId: { $exists: true } },
      { $rename: { patientId: "patient" } }
    );
    print(`Coleção ${coll}: patientId → patient`);
  }
});