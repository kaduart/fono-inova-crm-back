import { deriveFlagsFromText, resolveTopicFromFlags, computeTeaStatus } from '../utils/flagsDetector.js';

console.log('🧩 deriveFlagsFromText("meu filho tem 14 anos")');
console.log(deriveFlagsFromText("meu filho tem 14 anos"));

console.log('\n🧠 resolveTopicFromFlags("tenho dor na coluna")');
console.log(resolveTopicFromFlags({}, "tenho dor na coluna"));

console.log('\n💙 computeTeaStatus(TEA + laudo)');
console.log(computeTeaStatus({ mentionsTEA_TDAH: true, mentionsLaudo: true }, "ele tem laudo de TEA"));
