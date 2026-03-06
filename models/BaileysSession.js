/**
 * Modelo para armazenar sessão do Baileys no MongoDB
 * Permite persistência entre reinícios do servidor
 */

import mongoose from 'mongoose';

const baileysSessionSchema = new mongoose.Schema({
  sessionId: {
    type: String,
    required: true,
    unique: true,
    default: 'default'
  },
  creds: {
    type: Object,
    default: null
  },
  keys: {
    type: Map,
    of: String,
    default: new Map()
  }
}, {
  timestamps: true
});

const BaileysSession = mongoose.model('BaileysSession', baileysSessionSchema);

export default BaileysSession;
