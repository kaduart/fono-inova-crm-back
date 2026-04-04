#!/usr/bin/env node
/**
 * 🧪 TESTE - Simula processamento do frontend InsuranceTab
 */

import axios from 'axios';

const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4MDZkZDFiYjZmOTI1NTliNDlhOGE5YyIsInJvbGUiOiJhZG1pbiIsIm5hbWUiOiJSaWNhcmRvIE1haWEgQWRtaW4iLCJpYXQiOjE3NzUyNjE0MzAsImV4cCI6MTc3NTM0NzgzMH0.-vfv84RnFj_6sqpnZE--UctuahFPb88hp2rmXIE0CQY';

async function test() {
  try {
    console.log('=== TESTE INSURANCE TAB (simulando frontend) ===\n');
    
    const month = '2026-04';
    const subTab = 0; // A Faturar
    
    console.log('1. Buscando TODOS os dados (sem filtro de status)...');
    const allResponse = await axios.get('http://localhost:5000/api/v2/payments/insurance/receivables', {
      params: { month },
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    
    console.log('   allResponse.status:', allResponse.status);
    console.log('   allResponse.data.success:', allResponse.data.success);
    console.log('   allResponse.data.data.length:', allResponse.data.data?.length);
    console.log('   allResponse.data.summary:', allResponse.data.summary);
    
    const allData = allResponse.data.data || [];
    console.log('   allData.length:', allData.length);
    
    console.log('\n2. Buscando dados filtrados pela aba ativa...');
    const statusFilter = subTab === 0 ? 'pending_billing'
      : subTab === 1 ? 'billed'
      : 'received';
    
    console.log('   statusFilter:', statusFilter);
    
    const response = await axios.get('http://localhost:5000/api/v2/payments/insurance/receivables', {
      params: { month, status: statusFilter },
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    
    console.log('   response.status:', response.status);
    console.log('   response.data.success:', response.data.success);
    console.log('   response.data.data.length:', response.data.data?.length);
    
    const data = response.data.data || [];
    console.log('   data.length:', data.length);
    
    console.log('\n3. Aplicando filteredData (filtro do frontend)...');
    
    // Simula o filteredData do frontend
    const filteredData = data.map((group) => ({
      ...group,
      patients: (group.patients || []).map((p) => ({
        ...p,
        payments: (p.payments || []).filter((pay) => pay.grossAmount > 0 || pay.status === 'billed')
      })).filter((p) => p.payments.length > 0)
    })).filter((group) => group.patients.length > 0);
    
    console.log('   filteredData.length:', filteredData.length);
    
    if (filteredData.length === 0) {
      console.log('   ⚠️  PROBLEMA: filteredData está vazio!');
      console.log('\n   Verificando dados originais...');
      
      for (const group of data) {
        console.log(`\n   Provider: ${group._id}`);
        console.log(`   - patients: ${group.patients?.length}`);
        
        for (const patient of (group.patients || [])) {
          console.log(`\n     Patient: ${patient.patientName}`);
          console.log(`     - payments: ${patient.payments?.length}`);
          
          for (const pay of (patient.payments || [])) {
            console.log(`       Payment: grossAmount=${pay.grossAmount} (type: ${typeof pay.grossAmount}), status=${pay.status}`);
            const passesFilter = pay.grossAmount > 0 || pay.status === 'billed';
            console.log(`       - passes filter: ${passesFilter}`);
          }
        }
      }
    } else {
      console.log('   ✅ filteredData tem dados!');
      for (const g of filteredData) {
        console.log(`   - ${g._id}: ${g.patients.length} pacientes`);
      }
    }
    
    console.log('\n4. Calculando summary...');
    const totalPending = filteredData.reduce((acc, g) =>
      acc + (g.patients || []).reduce((pAcc, p) =>
        pAcc + (p.payments || []).filter((pay) => pay.status !== 'received').length, 0
      ), 0
    );
    
    const summary = {
      totalProviders: filteredData.length,
      grandTotal: filteredData.reduce((acc, g) => acc + (g.totalPending || 0), 0),
      pendingCount: totalPending
    };
    
    console.log('   summary:', summary);
    
    console.log('\n5. Calculando getMonthSummary...');
    const paymentMatchesMonth = (_payment) => true;
    
    const allPayments = allData.flatMap(g =>
      (g.patients || []).flatMap((p) =>
        (p.payments || []).filter(paymentMatchesMonth)
      )
    );
    
    console.log('   allPayments.length:', allPayments.length);
    
    const pendingPayments = allPayments.filter((p) => p.status === 'pending_billing');
    const billedPayments = allPayments.filter((p) => p.status === 'billed');
    const receivedPayments = allPayments.filter((p) => p.status === 'received');
    
    console.log('   pendingPayments:', pendingPayments.length);
    console.log('   billedPayments:', billedPayments.length);
    console.log('   receivedPayments:', receivedPayments.length);
    
    const monthSummary = {
      totalAFaturar: pendingPayments.reduce((s, p) => s + (p.grossAmount || 0), 0),
      totalFaturado: billedPayments.reduce((s, p) => s + (p.grossAmount || 0), 0),
      totalRecebido: receivedPayments.reduce((s, p) => s + (p.grossAmount || 0), 0),
    };
    
    console.log('   monthSummary:', monthSummary);
    
  } catch (error) {
    console.error('❌ Erro:', error.message);
    if (error.response) {
      console.error('   status:', error.response.status);
      console.error('   data:', error.response.data);
    }
  }
}

test();
