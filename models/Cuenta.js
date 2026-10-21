const mongoose = require('mongoose');

const cuentaSchema = new mongoose.Schema({
  cliente: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Cliente',
    required: true
  },
  monto: {
    type: Number,
    required: true,
    min: [1, 'El monto debe ser mayor a cero']
  },
  saldo: {
        type: Number,
        required: true,
        default: function() {
            return this.monto;
        }
    },
  fecha: {
    type: Date,
    default: Date.now
  },
  pagada: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Cuenta', cuentaSchema);