const mongoose = require('mongoose');

const ClienteSchema = new mongoose.Schema({
  nombre: { 
    type: String, 
    required: true,
    trim: true 
  },
  email: { 
    type: String, 
    required: true, 
    trim: true,
    lowercase: true 
  },
  telefono: { 
    type: String,
    trim: true 
  },
  // Mantenemos direccion por compatibilidad con registros previos
  direccion: { 
    type: String,
    trim: true 
  },
  // Desglose de dirección y escuela
  calle: { 
    type: String, 
    trim: true 
  },
  numeroExterior: { 
    type: String, 
    trim: true 
  },
  numeroInterior: { 
    type: String, 
    trim: true 
  },
  colonia: { 
    type: String, 
    trim: true 
  },
  ciudad: { 
    type: String, 
    trim: true 
  },
  estado: { 
    type: String, 
    trim: true 
  },
  codigoPostal: { 
    type: String, 
    trim: true 
  },
  universidad: { 
    type: String, 
    trim: true 
  },
  facultad: { 
    type: String, 
    trim: true 
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Cliente', ClienteSchema);