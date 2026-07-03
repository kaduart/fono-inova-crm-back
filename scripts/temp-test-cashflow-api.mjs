import 'dotenv/config';

const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjZhMjgwNmZiZDMzMGJkNWJlYzhlOGQzNyIsInJvbGUiOiJhZG1pbiIsImlhdCI6MTc4MzEwNjE0NSwiZXhwIjoxNzgzMTA5NzQ1fQ.bSvTM2E1yx3ByfW2wUZm49ns4UMQ-JaIw00mBucjBVU';
const res = await fetch('http://localhost:5000/api/v2/cashflow?date=2026-07-03', {
  headers: {
    'Accept': 'application/json',
    'Authorization': `Bearer ${token}`,
    'x-correlation-id': 'test_debug_001'
  }
});
const data = await res.json();
console.log('Status:', res.status);
console.log('Cache headers:', Object.fromEntries(res.headers.entries()));
console.log('Producao total:', data.data.producao.total);
console.log('Quantidade atendimentos:', data.data.producao.quantidadeAtendimentos);
console.log('Convenios atendidos count:', data.data.conveniosAtendidos.length);
console.log('Transacoes count:', data.data.transacoes.length);
