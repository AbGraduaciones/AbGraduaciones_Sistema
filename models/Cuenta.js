const mongoose = require('mongoose');

const cuentaSchema = new mongoose.Schema({
  id: {
    type: String
  },
  cliente: {
    type: mongoose.Schema.Types.Mixed,
    ref: 'Cliente',
    required: true
  },
  alumno: {
    type: String
  },
  paquete: {
    type: String
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
  pagos: {
    type: [Number],
    default: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  },
  entregas: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  eleccionEspecial: {
    type: String,
    default: ''
  },
  esContadoEfectivo: {
    type: Boolean,
    default: false
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