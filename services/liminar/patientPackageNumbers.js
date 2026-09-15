import Package from '../../models/Package.js';

// Include archived packages so filtering the screen never changes the numbering.
export async function getPatientPackageNumbers(patientId) {
  const packages = await Package.find({ patient: patientId }).select('_id sessionType sequenceNumber').sort({ _id: 1 }).lean();
  const used = new Map();
  for (const pack of packages) {
    const numbers = used.get(pack.sessionType) || new Set();
    if (pack.sequenceNumber) numbers.add(pack.sequenceNumber);
    used.set(pack.sessionType, numbers);
  }
  return new Map(packages.map(pack => {
    let number = pack.sequenceNumber;
    if (!number) {
      number = 1;
      while (used.get(pack.sessionType).has(number)) number++;
      used.get(pack.sessionType).add(number);
    }
    return [String(pack._id), number];
  }));
}
