const express = require('express');
const router = express.Router();
const clienteController = require('../controllers/clienteController');

// Obtener todos los clientes
router.get('/', clienteController.getClientes);

// Crear un cliente
router.post('/', clienteController.crearCliente);

// Obtener un cliente por ID
router.get('/:id', clienteController.getClienteById);

// Actualizar un cliente
router.put('/:id', clienteController.updateCliente);

// Eliminar un cliente
router.delete('/:id', clienteController.deleteCliente);

module.exports = router;