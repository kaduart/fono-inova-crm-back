import mongoose from 'mongoose';

const metricSchema = new mongoose.Schema({
  name: { 
    type: String, 
    required: true 
  },
  description: String,
  type: { 
    type: String, 
    enum: ['language', 'motor', 'cognitive', 'behavior', 'social'],
    required: true 
  },
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