const express = require('express');
const router = express.Router();
const pagoController = require('../controllers/pagoController');

// POST /api/pagos/crear-checkout-session
router.post('/crear-checkout-session', pagoController.crearCheckoutSession);

// GET /api/pagos
router.get('/', pagoController.obtenerPagos);

// POST /api/pagos
router.post('/', pagoController.crearPago);

// GET /api/pagos/cuenta/:cuentaId
router.get('/cuenta/:cuentaId', pagoController.obtenerPagosPorCuenta);

// PUT /api/pagos/:id
router.put('/:id', pagoController.actualizarPago);

// DELETE /api/pagos/:id
router.delete('/:id', pagoController.eliminarPago);

module.exports = router;