const mongoose = require('mongoose');

const pagoSchema = new mongoose.Schema({
    cuenta: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Cuenta',
        required: [true, 'La cuenta asociada es obligatoria']
    },
    cliente: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Cliente',
        required: [true, 'El cliente es obligatorio']
    },
    monto: {
        type: Number,
        required: [true, 'El monto del pago es obligatorio'],
        min: [0, 'El monto no puede ser negativo']
    },
    fecha: {
        type: Date,
        default: Date.now
    },
    metodoPago: {
        type: String,
        enum: ['efectivo', 'transferencia', 'tarjeta', 'otro'],
        default: 'efectivo'
    },
    notas: {
        type: String,
        trim: true
    }
}, {
    timestamps: true
});

module.exports = mongoose.model('Pago', pagoSchema);