// mongooseTrap.js
import mongoose from "mongoose";

console.log("✅ mongooseTrap carregou (TOP 1)");

const orig = mongoose.SchemaType.prototype.doValidate;

function hardLog(obj) {
  try {
    // stderr costuma flushar melhor antes do crash
    process.stderr.write(JSON.stringify(obj, null, 2) + "\n");
  } catch {
    // fallback
    console.error(obj);
  }
}

mongoose.SchemaType.prototype.doValidate = function (value, fn, scope, options) {
  const modelName = scope?.constructor?.modelName;
  const docId = scope?._id;
  const path = this?.path;
  const instance = this?.instance;

  // 🔥 1) Loga TODA vez que chegar boolean aqui (true/false)
  if (typeof value === "boolean") {
    hardLog({
      tag: "🚨 BOOLEAN CHEGOU NO VALIDATOR (PRE)",
      model: modelName,
      _id: docId?.toString?.() || docId,
      path,
      instance,
      value,
    });

    // Airbag: se for ObjectId, converte pra null pra não crashar
    if (instance === "ObjectId" || instance === "ObjectID") {
      value = null;
    }
  }

  // 🔥 2) Agora chama o validate original, mas captura o crash e imprime contexto
  try {
    return orig.call(this, value, fn, scope, options);
  } catch (e) {
    hardLog({
      tag: "💥 CRASH DENTRO DO VALIDATE (CATCH)",
      model: modelName,
      _id: docId?.toString?.() || docId,
      path,
      instance,
      valueType: typeof value,
      value,
      message: e?.message,
      stackTop: String(e?.stack || "").split("\n").slice(0, 8).join("\n"),
    });

    throw e;
  }
};
