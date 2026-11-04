const mongoose = require('mongoose');
const Cliente = require('../models/Cliente');

// Función auxiliar para buscar por id numérico/string o por ObjectId
const construirFiltroId = (paramId) => {
  if (mongoose.Types.ObjectId.isValid(paramId)) {
    return { $or: [{ _id: paramId }, { id: String(paramId) }] };
  }
  return { id: String(paramId) };
};

exports.getClientes = async (req, res) => {
  try {
    const clientes = await Cliente.find().lean();
    res.status(200).json(clientes);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.crearCliente = async (req, res) => {
  try {
    const datos = {
      ...req.body,
      email: req.body.email || '',
      grupoId: req.body.grupoId || null,
      grupoNombre: req.body.grupoNombre || ''
    };
    const nuevoCliente = new Cliente(datos);
    const clienteGuardado = await nuevoCliente.save();
    res.status(201).json(clienteGuardado);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.getClienteById = async (req, res) => {
  try {
    const filtro = construirFiltroId(req.params.id);
    const cliente = await Cliente.findOne(filtro).lean();
    if (!cliente) return res.status(404).json({ message: 'Cliente no encontrado' });
    res.status(200).json(cliente);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.updateCliente = async (req, res) => {
  try {
    const filtro = construirFiltroId(req.params.id);
    const clienteActualizado = await Cliente.findOneAndUpdate(
      filtro,
      { $set: req.body },
      { new: true, runValidators: false }
    );
    if (!clienteActualizado) return res.status(404).json({ message: 'Cliente no encontrado' });
    res.status(200).json(clienteActualizado);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

exports.deleteCliente = async (req, res) => {
  try {
    const filtro = construirFiltroId(req.params.id);
    const clienteEliminado = await Cliente.findOneAndDelete(filtro);
    if (!clienteEliminado) return res.status(404).json({ message: 'Cliente no encontrado' });
    res.status(200).json({ message: 'Cliente eliminado con éxito' });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};