const express = require('express');
const router = express.Router();
const cuentasController = require('../controllers/cuentas');

router.post('/', cuentasController.crearCuenta);
router.get('/', cuentasController.obtenerCuentas);

module.exports = router;
router.patch('/:id/pagada', cuentasController.actualizarCuentaAPagada);
router.delete('/:id',cuentasController.eliminarCuenta);
router.get('/:id', cuentasController.obtenerCuenta);