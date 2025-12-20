// scripts/amanda-smoke.mjs
import assert from "node:assert/strict";
import mongoose from "mongoose";

// 1) garante que o model LearningInsight existe (idempotente no arquivo do model)
import "../models/LearningInsight.js";

// 2) importa o orquestrador
import { getOptimizedAmandaResponse } from "../utils/amandaOrchestrator.js";

// 3) importa Leads (vamos mockar writes)
import Leads from "../models/Leads.js";

// =========================
// Helpers
// =========================
function countHearts(s = "") {
  return (String(s).match(/💚/g) || []).length;
}

function mustHaveOneHeart(s) {
  const count = countHearts(s);
  assert.equal(count, 1, `Esperava exatamente 1 💚, veio: ${count} | resp="${s}"`);
}

// mock de query chain do mongoose: findOne().sort().lean()/exec()
function mockQuery(result) {
  return {
    sort() { return this; },
    select() { return this; },
    limit() { return this; },
    lean() { return Promise.resolve(result); },
    exec() { return Promise.resolve(result); },
  };
}

async function run() {
  console.log("🧪 Amanda Smoke Test\n");

  // =========================================
  // MOCK LearningInsight (evita Mongo)
  // =========================================
  const LI = mongoose.models.LearningInsight;
  const originalLI = {};
  if (LI) {
    originalLI.findOne = LI.findOne;
    originalLI.find = LI.find;
    originalLI.create = LI.create;
    originalLI.updateOne = LI.updateOne;

    LI.findOne = () => mockQuery(null);
    LI.find = () => mockQuery([]);
    LI.create = async () => null;
    LI.updateOne = async () => ({ acknowledged: true, modifiedCount: 0 });
  }

  // =========================================
  // MOCK DB writes no Leads (não encosta no Mongo)
  // =========================================
  const updates = [];
  const originalUpdate = Leads.findByIdAndUpdate;
  const originalFindById = Leads.findById;

  Leads.findByIdAndUpdate = async (id, update) => {
    updates.push({ id, update });
    return null;
  };

Leads.findById = () => ({
  populate() { return this; },
  lean() { return Promise.resolve(null); },
  exec() { return Promise.resolve(null); }
});

  try {
    // 1) Plano/convênio -> particular + reembolso
    {
      const resp = await getOptimizedAmandaResponse({
        userText: "Vocês atendem pela Unimed? Só faço se for pelo plano.",
        lead: {}, // sem _id => sem DB
        context: {},
        messageId: "t1",
      });

      console.log("CASE 1:", resp);
      mustHaveOneHeart(resp);
      assert.match(resp.toLowerCase(), /particular|reembolso|recibo|nota/i);
    }

    // 2) Agendar genérico sem área/idade -> triagem (idade/área)
    {
      const resp = await getOptimizedAmandaResponse({
        userText: "Quero agendar uma avaliação",
        lead: {},
        context: {},
        messageId: "t2",
      });

      console.log("CASE 2:", resp);
      mustHaveOneHeart(resp);
      assert.match(resp.toLowerCase(), /idade|meses|anos|qual a idade/i);
    }

    // 3) Escopo negativo (orelhinha) -> não realizamos
    {
      const resp = await getOptimizedAmandaResponse({
        userText: "Vocês fazem teste da orelhinha?",
        lead: {},
        context: {},
        messageId: "t3",
      });

      console.log("CASE 3:", resp);
      mustHaveOneHeart(resp);
      assert.match(resp.toLowerCase(), /não realizamos|nao realizamos/i);
    }

    // 4) Já tem slots pendentes e lead responde algo que NÃO é escolha -> re-lista opções A-F
    {
      const lead = {
        _id: "507f1f77bcf86cd799439011",
        pendingSchedulingSlots: {
          primary: { date: "2025-12-23", time: "14:00", doctorName: "Dra. X", doctorId: "1" },
          alternativesSamePeriod: [
            { date: "2025-12-23", time: "15:00", doctorName: "Dra. X", doctorId: "1" },
            { date: "2025-12-24", time: "16:00", doctorName: "Dr. Y", doctorId: "2" },
          ],
          alternativesOtherPeriod: [
            { date: "2025-12-26", time: "12:00", doctorName: "Dr. Z", doctorId: "3" },
          ],
        },
      };

      const resp = await getOptimizedAmandaResponse({
        userText: "Pode ser",
        lead,
        context: {},
        messageId: "t4",
      });

      console.log("CASE 4:", resp);
      mustHaveOneHeart(resp);
      assert.match(resp, /A\)|B\)|C\)/);
    }

    // 5) Escolheu A -> pede nome + nascimento e registra update
    {
      updates.length = 0;

      const lead = {
        _id: "507f1f77bcf86cd799439012",
        pendingSchedulingSlots: {
          primary: { date: "2025-12-23", time: "14:00", doctorName: "Dra. X", doctorId: "1" },
          alternativesSamePeriod: [],
          alternativesOtherPeriod: [],
        },
      };

      const resp = await getOptimizedAmandaResponse({
        userText: "A",
        lead,
        context: {},
        messageId: "t5",
      });

      console.log("CASE 5:", resp);
      mustHaveOneHeart(resp);
      assert.match(resp.toLowerCase(), /nome completo|data de nascimento/i);
      assert.equal(updates.length > 0, true, "Esperava pelo menos 1 findByIdAndUpdate");
    }

    console.log("\n✅ Smoke test OK");
  } finally {
    // restore Leads mocks
    Leads.findByIdAndUpdate = originalUpdate;
    Leads.findById = originalFindById;

    // restore LearningInsight mocks
    const LI2 = mongoose.models.LearningInsight;
    if (LI2 && originalLI.findOne) {
      LI2.findOne = originalLI.findOne;
      LI2.find = originalLI.find;
      LI2.create = originalLI.create;
      LI2.updateOne = originalLI.updateOne;
    }
  }
}

run().catch((e) => {
  console.error("\n❌ Smoke test FALHOU:", e);
  process.exit(1);
});
