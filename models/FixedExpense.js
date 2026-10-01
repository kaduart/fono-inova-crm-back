import mongoose from 'mongoose';
import { CREATED_BY_ROLES } from '../constants/roles.js';

/**
 * Modelo de despesa fixa (aluguel, internet, folha fixa...).
 *
 * NÃO é a despesa em si: a despesa real é uma ocorrência (`Expense` com
 * fixedExpenseId + competenceMonth), criada por competência pelo serviço de
 * geração. Editar o modelo só afeta gerações futuras (exceto quando o usuário
 * pede para aplicar à ocorrência pendente do mês).
 */
const fixedExpenseSchema = new mongoose.Schema({
    description: { type: String, required: true, trim: true, maxlength: 200 },

    // 'commission' fica de fora: comissão tem fluxo próprio (commissionService).
    category: {
        type: String,
        required: true,
        enum: ['payroll', 'benefit', 'operational', 'equipment', 'marketing', 'other']
    },

    subcategory: {
        type: String,
        enum: [
            'salary', 'bonus', 'transport', 'meal_voucher', 'health_insurance',
            'rent', 'utilities', 'supplies', 'maintenance', 'advertising', 'other'
        ],
        default: null
    },

    amount: { type: Number, required: true, min: [0.01, 'Valor deve ser maior que zero'] },

    // Dia do vencimento (1-31). Maior que os dias do mês → último dia do mês.
    dueDay: { type: Number, required: true, min: 1, max: 31 },

    paymentMethod: {
        type: String,
        enum: ['dinheiro', 'pix', 'transferencia_bancaria', 'cartao_credito', 'cartao_debito', 'boleto', 'outro'],
        required: true
    },

    // Só mensal por ora; enum já aceita expandir sem migração.
    frequency: { type: String, enum: ['monthly'], default: 'monthly' },

    // 'YYYY-MM-DD' (mesmo formato de Expense.date). A ocorrência só é gerada se o
    // vencimento do mês cair dentro de [startDate, endDate].
    startDate: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    endDate: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },

    active: { type: Boolean, default: true, index: true },

    notes: { type: String, maxlength: 2000, default: '' },

    createdBy: { type: mongoose.Schema.Types.ObjectId, required: true },
    createdByRole: { type: String, enum: CREATED_BY_ROLES, required: true },
    createdByName: { type: String, default: 'Sistema' }
}, { timestamps: true });

const FixedExpense = mongoose.model('FixedExpense', fixedExpenseSchema);
export default FixedExpense;
