const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const Pago = require('../models/Pago');
const Cuenta = require('../models/Cuenta');
// Registrar un nuevo pago manual y actualizar el saldo de la cuenta
exports.crearPago = async (req, res) => {
    try {
        const { cuenta, monto } = req.body;

        // 1. Crear el registro del pago
        const nuevoPago = new Pago(req.body);
        await nuevoPago.save();

        // 2. Descontar el monto pagado del saldo de la cuenta
        await Cuenta.findByIdAndUpdate(cuenta, {
            $inc: { saldo: -monto } // Resta el monto pagado al saldo actual
        });

        res.status(201).json({
            status: 'ok',
            message: 'Pago registrado y saldo actualizado correctamente',
            data: nuevoPago
        });
    } catch (error) {
        res.status(400).json({
            status: 'error',
            message: error.message
        });
    }
};

// Webhook de Stripe: procesa notificaciones automáticas de pago
exports.handleStripeWebhook = async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;

    try {
        // Stripe requiere el buffer crudo (raw body) para verificar la firma
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        console.error(`Error en la firma del webhook: ${err.message}`);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Manejar el evento de pago completado
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;

        try {
            // Lee los datos enviados previamente en session.metadata
            const cuentaId = session.metadata?.cuentaId;
            const clienteId = session.metadata?.clienteId;
            const monto = session.amount_total ? session.amount_total / 100 : 0;

            if (cuentaId) {
                // Registrar el pago en la base de datos
                const nuevoPago = new Pago({
                    cuenta: cuentaId,
                    cliente: clienteId,
                    monto: monto,
                    metodoPago: 'stripe',
                    transaccionId: session.id,
                    estado: 'completado'
                });
                await nuevoPago.save();

                // Descontar el saldo de la cuenta
                await Cuenta.findByIdAndUpdate(cuentaId, {
                    $inc: { saldo: -monto }
                });

                console.log(`Pago procesado con éxito para la cuenta: ${cuentaId}`);
            }
        } catch (dbError) {
            console.error('Error al registrar pago en BD:', dbError.message);
            return res.status(500).json({ error: 'Error interno al actualizar la base de datos' });
        }
    }

    // Responder 200 a Stripe para confirmar recepción
    res.status(200).json({ received: true });
};

// Obtener todos los pagos
exports.obtenerPagos = async (req, res) => {
    try {
        const pagos = await Pago.find()
            .populate('cliente', 'nombre email')
            .populate('cuenta');
        res.status(200).json({
            status: 'ok',
            data: pagos
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
};

// Obtener el historial de pagos de una cuenta específica
exports.obtenerPagosPorCuenta = async (req, res) => {
    try {
        const { cuentaId } = req.params;

        const pagos = await Pago.find({ cuenta: cuentaId })
            .populate('cliente', 'nombre email')
            .sort({ createdAt: -1 });

        res.status(200).json({
            status: 'ok',
            totalPagos: pagos.length,
            data: pagos
        });
    } catch (error) {
        res.status(400).json({
            status: 'error',
            message: error.message
        });
    }
};

// Actualizar un pago existente por su ID
exports.actualizarPago = async (req, res) => {
    try {
        const { id } = req.params;
        const pagoActualizado = await Pago.findByIdAndUpdate(id, req.body, {
            new: true,
            runValidators: true
        });

        if (!pagoActualizado) {
            return res.status(404).json({
                status: 'error',
                message: 'No se encontró el pago especificado.'
            });
        }

        res.status(200).json({
            status: 'ok',
            message: 'Pago actualizado correctamente',
            data: pagoActualizado
        });
    } catch (error) {
        res.status(400).json({
            status: 'error',
            message: error.message
        });
    }
};

// Eliminar/Cancelar un pago por su ID
exports.eliminarPago = async (req, res) => {
    try {
        const { id } = req.params;

        const pagoAEliminar = await Pago.findById(id);

        if (!pagoAEliminar) {
            return res.status(404).json({
                status: 'error',
                message: 'No se encontró el pago especificado.'
            });
        }

        // Revertir el saldo en la cuenta
        await Cuenta.findByIdAndUpdate(pagoAEliminar.cuenta, {
            $inc: { saldo: pagoAEliminar.monto }
        });

        await Pago.findByIdAndDelete(id);

        res.status(200).json({
            status: 'ok',
            message: 'Pago cancelado y saldo restablecido en la cuenta'
        });
    } catch (error) {
        res.status(400).json({
            status: 'error',
            message: error.message
        });
    }
};