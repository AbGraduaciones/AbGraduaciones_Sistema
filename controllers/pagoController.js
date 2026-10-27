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
      const condiciones = [{ id: cuenta }];
      if (mongoose.Types.ObjectId.isValid(cuenta)) {
        condiciones.unshift({ _id: cuenta });
      }

      await Cuenta.findOneAndUpdate(
        { $or: condiciones },
        { $inc: { saldo: -Number(monto), saldoPendiente: -Number(monto) } }
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

// Webhook de Stripe
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
    const nombreAlumno = (metadata.nombreAlumno || (session.customer_details && session.customer_details.name) || 'Alumno').trim();
    const cuentaId = metadata.cuentaId || metadata.cuenta_id || `CTA-${nombreAlumno}`;
    const clienteId = metadata.clienteId || metadata.alumnoId || 'ALU-001';
    const concepto = metadata.concepto || 'Abono en Línea (Stripe)';

    console.log(`💳 Procesando pago de $${monto} para: ${nombreAlumno} (Cuenta: ${cuentaId})`);

    // 1. Sincronización en memoria compartida (Frontend local / demo)
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

      if (!Array.isArray(global.datosCompartidos.pagos)) {
        global.datosCompartidos.pagos = [];
      }
      global.datosCompartidos.pagos.unshift(pagoFrontend);

      // Búsqueda flexible de la cuenta en memoria
      const saldoEncontrado = (global.datosCompartidos.saldos || []).find(s => {
        const idMatch = (s.id && s.id === cuentaId) || (s._id && String(s._id) === String(cuentaId));
        const nombreS = (s.alumno || s.nombre || s.nombreAlumno || '').trim().toLowerCase();
        const nombreM = nombreAlumno.toLowerCase();
        return idMatch || (nombreS && (nombreS === nombreM || nombreS.includes(nombreM) || nombreM.includes(nombreS)));
      });

      if (saldoEncontrado) {
        if (!Array.isArray(saldoEncontrado.pagos)) {
          saldoEncontrado.pagos = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        }

        // Asignar en la primera casilla vacía de Pago 1 a Pago 10
        let asignado = false;
        for (let i = 0; i < 10; i++) {
          if (!saldoEncontrado.pagos[i] || Number(saldoEncontrado.pagos[i]) === 0) {
            saldoEncontrado.pagos[i] = monto;
            asignado = true;
            break;
          }
        }
        if (!asignado) {
          saldoEncontrado.pagos[9] = (parseFloat(saldoEncontrado.pagos[9]) || 0) + monto;
        }

        // Descontar saldo y recalcular
        const montoTotal = Number(saldoEncontrado.montoTotal || saldoEncontrado.total || 0);
        const totalAbonado = saldoEncontrado.pagos.reduce((acc, curr) => acc + (Number(curr) || 0), 0);

        if (montoTotal > 0) {
          saldoEncontrado.saldoPendiente = Math.max(0, montoTotal - totalAbonado);
          saldoEncontrado.saldo = saldoEncontrado.saldoPendiente;
        } else {
          if (saldoEncontrado.saldoPendiente !== undefined) {
            saldoEncontrado.saldoPendiente = Math.max(0, Number(saldoEncontrado.saldoPendiente) - monto);
          }
          if (saldoEncontrado.saldo !== undefined) {
            saldoEncontrado.saldo = Math.max(0, Number(saldoEncontrado.saldo) - monto);
          }
        }

        saldoEncontrado.totalPagado = totalAbonado;
        console.log(`✅ Abono reflejado en memoria para: ${saldoEncontrado.alumno || nombreAlumno}. Saldo restante: ${saldoEncontrado.saldoPendiente}`);
      } else {
        console.warn(`⚠️ No se encontró la cuenta en memoria para: ${nombreAlumno} (Cuenta: ${cuentaId})`);
      }
    }

    // 2. Persistencia en MongoDB (Se ejecuta siempre, confiando en el buffer o conexión activa)
    try {
      const nuevoPagoBD = new Pago({
        cuenta: cuentaId,
        cliente: clienteId,
        monto: monto,
        metodoPago: 'stripe',
        notas: `Stripe Session: ${session.id}`
      });
      await nuevoPagoBD.save();

      const condiciones = [
        { id: cuentaId },
        { alumno: new RegExp(`^${nombreAlumno}$`, 'i') },
        { nombre: new RegExp(`^${nombreAlumno}$`, 'i') }
      ];

      if (mongoose.Types.ObjectId.isValid(cuentaId)) {
        condiciones.unshift({ _id: cuentaId });
      }

      const cuentaActualizada = await Cuenta.findOneAndUpdate(
        { $or: condiciones },
        { 
          $inc: { saldo: -Number(monto), saldoPendiente: -Number(monto), totalPagado: Number(monto) },
          $push: { pagosHistorial: nuevoPagoBD._id }
        },
        { new: true }
      );

      if (cuentaActualizada) {
        console.log(`✅ Pago de $${monto} aplicado en MongoDB para la cuenta: ${cuentaActualizada._id}`);
      } else {
        console.warn(`⚠️ No se encontró documento en Cuenta de MongoDB que coincida con cuentaId: ${cuentaId} o alumno: ${nombreAlumno}`);
      }
    } catch (dbError) {
      console.error('❌ Error guardando en base de datos:', dbError.message);
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

    const condiciones = [{ id: pagoAEliminar.cuenta }];
    if (mongoose.Types.ObjectId.isValid(pagoAEliminar.cuenta)) {
      condiciones.unshift({ _id: pagoAEliminar.cuenta });
    }

    await Cuenta.findOneAndUpdate(
      { $or: condiciones },
      { $inc: { saldo: pagoAEliminar.monto, saldoPendiente: pagoAEliminar.monto } }
    );
    await Pago.findByIdAndDelete(id);

    res.status(200).json({ status: 'ok', message: 'Pago cancelado y saldo restablecido' });
  } catch (error) {
    res.status(400).json({ status: 'error', message: error.message });
  }
};