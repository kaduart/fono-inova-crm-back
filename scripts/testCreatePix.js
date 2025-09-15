import axios from 'axios';

const appointmentId = '68894826d6d2214f6d7b58bb'; // coloque um ID válido do MongoDB
const baseUrl = 'http://localhost:5000/api/sicoob';

async function testCreatePix() {
    try {
        const resp = await axios.post(`http://localhost:5000/api/pix/create/${appointmentId}`)
            .then(res => console.log(res.data))
            .catch(err => console.error('❌ Erro ao criar PIX:', err.response?.data || err.message));

        console.log('💳 Cobrança PIX criada:');
        console.log(resp.data);
    } catch (err) {
        console.error('❌ Erro ao criar PIX:', err.response?.data || err.message);
    }
}

testCreatePix();
