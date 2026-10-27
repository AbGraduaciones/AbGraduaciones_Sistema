const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Pago = require('../models/Pago');
const Cuenta = require('../models/Cuenta');
const mongoose = require('mongoose');

// Registrar un nuevo pago manual
exports.crearPago = async (req, res) => {
  try {
    const { cuenta, monto } = req.body;
    const nuevoPago = new Pago(req.body);
    await nuevoPago.save();

    if (cuenta) {
      await Cuenta.findOneAndUpdate(
        { $or: [{ _id: cuenta }, { id: cuenta }] },
        { $inc: { saldo: -monto } }
      );
    }

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

// Webhook de Stripe blindado contra caídas de base de datos
exports.handleStripeWebhook = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    if (endpointSecret && sig) {
      event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error(`❌ Error en la firma del webhook: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log(`🔔 Evento recibido de Stripe: ${event.type}`);

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const metadata = session.metadata || {};
    const monto = session.amount_total ? session.amount_total / 100 : 0;
    const nombreAlumno = metadata.nombreAlumno || (session.customer_details && session.customer_details.name) || 'Alumno';
    const cuentaId = metadata.cuentaId || metadata.cuenta_id || `CTA-${nombreAlumno}`;
    const clienteId = metadata.clienteId || metadata.alumnoId || 'ALU-001';
    const concepto = metadata.concepto || 'Abono en Línea (Stripe)';

    console.log(`💳 Procesando pago de $${monto} para: ${nombreAlumno} (Cuenta: ${cuentaId})`);

    // 1. Sincronización en memoria compartida
    if (global.datosCompartidos) {
      const nuevoFolioNum = (global.datosCompartidos.pagos || []).length + 1;
      const folioId = 'PAG-' + String(nuevoFolioNum).padStart(3, '0');

      const pagoFrontend = {
        id: folioId,
        alumno: nombreAlumno,
        concepto: concepto,
        monto: monto,
        fecha: new Date().toISOString().split('T')[0],
        metodo: 'Tarjeta (Stripe)',
        estado: 'Completado'
      };

      global.datosCompartidos.pagos.unshift(pagoFrontend);

      const saldoEncontrado = global.datosCompartidos.saldos.find(s =>
        (s.id && s.id === cuentaId) ||
        (s._id && s._id === cuentaId) ||
        (s.alumno && s.alumno.toLowerCase() === nombreAlumno.toLowerCase())
      );

      if (saldoEncontrado) {
        if (!Array.isArray(saldoEncontrado.pagos)) {
          saldoEncontrado.pagos = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        }
        let asignado = false;
        for (let i = 0; i < 10; i++) {
          if (!saldoEncontrado.pagos[i] || saldoEncontrado.pagos[i] === 0) {
            saldoEncontrado.pagos[i] = monto;
            asignado = true;
            break;
          }
        }
        if (!asignado) {
          saldoEncontrado.pagos[9] = (parseFloat(saldoEncontrado.pagos[9]) || 0) + monto;
        }
        console.log(`✅ Abono reflejado en memoria para: ${saldoEncontrado.alumno}`);
      }
    }

    // 2. Guardar en MongoDB solo si la conexión está lista
    if (mongoose.connection.readyState === 1) {
      try {
        const nuevoPagoBD = new Pago({
          cuenta: cuentaId,
          cliente: clienteId,
          monto: monto,
          metodoPago: 'stripe',
          notas: `Stripe Session: ${session.id}`
        });
        await nuevoPagoBD.save();

        await Cuenta.findOneAndUpdate(
          { $or: [{ _id: cuentaId }, { id: cuentaId }] },
          { $inc: { saldo: -monto } }
        );
        console.log(`✅ Pago de $${monto} guardado exitosamente en MongoDB.`);
      } catch (dbError) {
        console.error('⚠️ Aviso en base de datos (pago retenido en memoria):', dbError.message);
      }
    } else {
      console.warn('⚠️ MongoDB no estaba listo al recibir el webhook; el pago quedó asegurado en memoria.');
    }
  }

  return res.status(200).json({ received: true });
};

// Obtener todos los pagos
exports.obtenerPagos = async (req, res) => {
  try {
    const pagos = await Pago.find().sort({ createdAt: -1 });
    res.status(200).json({ status: 'ok', data: pagos });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
};

// Obtener el historial de pagos por cuenta
exports.obtenerPagosPorCuenta = async (req, res) => {
  try {
    const { cuentaId } = req.params;
    const pagos = await Pago.find({ cuenta: cuentaId }).sort({ createdAt: -1 });
    res.status(200).json({ status: 'ok', totalPagos: pagos.length, data: pagos });
  } catch (error) {
    res.status(400).json({ status: 'error', message: error.message });
  }
};

// Actualizar un pago existente
exports.actualizarPago = async (req, res) => {
  try {
    const { id } = req.params;
    const pagoActualizado = await Pago.findByIdAndUpdate(id, req.body, { new: true, runValidators: true });
    if (!pagoActualizado) return res.status(404).json({ status: 'error', message: 'No se encontró el pago' });
    res.status(200).json({ status: 'ok', data: pagoActualizado });
  } catch (error) {
    res.status(400).json({ status: 'error', message: error.message });
  }
};

// Eliminar un pago
exports.eliminarPago = async (req, res) => {
  try {
    const { id } = req.params;
    const pagoAEliminar = await Pago.findById(id);
    if (!pagoAEliminar) return res.status(404).json({ status: 'error', message: 'No se encontró el pago' });

    await Cuenta.findOneAndUpdate(
      { $or: [{ _id: pagoAEliminar.cuenta }, { id: pagoAEliminar.cuenta }] },
      { $inc: { saldo: pagoAEliminar.monto } }
    );
    await Pago.findByIdAndDelete(id);

    res.status(200).json({ status: 'ok', message: 'Pago cancelado y saldo restablecido' });
  } catch (error) {
    res.status(400).json({ status: 'error', message: error.message });
  }
};