const mongoose = require('mongoose');

const ClienteSchema = new mongoose.Schema({
  nombre: { type: String, required: true },
  email: { type: String, required: true },
  telefono: { type: String },
  direccion: { type: String }
});

module.exports = mongoose.model('Cliente', ClienteSchema);