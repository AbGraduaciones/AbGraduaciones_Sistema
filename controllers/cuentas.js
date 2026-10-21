const Cuenta = require('../models/Cuenta');

// Crear una nueva cuenta
exports.crearCuenta = async (req, res) => {
  try {
    const nuevaCuenta = new Cuenta(req.body);
    const cuentaGuardada = await nuevaCuenta.save();
    await cuentaGuardada.populate('cliente');
    res.status(201).json(cuentaGuardada);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

// Obtener todas las cuentas
exports.obtenerCuentas = async (req, res) => {
  const { page = 1, limit = 100 } = req.query;
  try {
    const cuentas = await Cuenta.find()
      .populate('cliente', 'nombre email')
      .limit(limit)
      .skip((page - 1) * limit)
      .exec();
    const count = await Cuenta.countDocuments();
    res.json({
      cuentas,
      totalPages: Math.ceil(count / limit),
      currentPage: page
    });
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
exports.actualizarCuentaAPagada = async (req, res) => {
  try {
    const cuenta = await Cuenta.findByIdAndUpdate(
      req.params.id,
      { pagada: true },
      { new: true }
    );
    if (!cuenta) return res.status(404).json({ message: 'Cuenta no encontrada' });
    res.json(cuenta);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};
exports.eliminarCuenta = async (req, res) => { try { const cuenta = await Cuenta.findByIdAndDelete(req.params.id); if (!cuenta) return res.status(404).json({ message: 'Cuenta no encontrada' }); res.status(200).json({ message: 'Cuenta eliminada con éxito' }); } catch (error) { res.status(500).json({ message: error.message }); } };
exports.obtenerCuenta = async (req, res) => {
    try {
        const cuenta = await Cuenta.findById(req.params.id)
            .populate('cliente', 'nombre email');
        if (!cuenta) {
            return res.status(404).json({
                status: 'error',
                message: 'Cuenta no encontrada'
            });
        }
        res.status(200).json({
            status: 'ok',
            data: cuenta
        });
    } catch (error) {
        res.status(400).json({
            status: 'error',
            message: error.message
        });
    }
};