import mongoose from 'mongoose';

const metricSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true
  },
  description: String,
  // No modelo Metric (backend), adicione:
  type: {
    type: String,
    enum: ['range', 'boolean', 'scale'],
    default: 'range'
  },
  options: { type: Array },
  minValue: {
    type: Number,
    default: 0
  },
  maxValue: {
    type: Number,
    default: 10
  },
  unit: String
});

const Metric = mongoose.model('Metric', metricSchema);
export default Metric;