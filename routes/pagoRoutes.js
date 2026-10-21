const express = require('express');
const router = express.Router();
const pagoController = require('../controllers/pagoController');

// GET /api/pagos - Obtener todos los pagos
router.get('/', pagoController.obtenerPagos);

// POST /api/pagos - Crear un nuevo pago
router.post('/', pagoController.crearPago);

// GET /api/pagos/cuenta/:cuentaId - Obtener historial por ID de cuenta
router.get('/cuenta/:cuentaId', pagoController.obtenerPagosPorCuenta);

// PUT /api/pagos/:id - Editar un pago existente
router.put('/:id', pagoController.actualizarPago);

// DELETE /api/pagos/:id - Eliminar un pago
router.delete('/:id', pagoController.eliminarPago);

module.exports = router;