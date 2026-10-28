const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Pago = require('../models/Pago');
const Cuenta = require('../models/Cuenta');
const mongoose = require('mongoose');

// Limpia formatos monetarios ("$11,300", "-", null) a números reales
const limpiarNumero = (val) => {
  if (typeof val === 'number') return isNaN(val) ? 0 : val;
  if (!val || val === '-') return 0;
  const limpio = String(val).replace(/[^0-9.-]+/g, '');
  const num = parseFloat(limpio);
  return isNaN(num) ? 0 : num;
};

// Crear sesión de Stripe Checkout
exports.crearCheckoutSession = async (req, res) => {
  try {
    const { 
      monto, 
      concepto = 'Abono de Graduación', 
      nombreAlumno = 'Alumno', 
      alumnoId = 'ALU-001', 
      cuentaId = 'CTA-001',
      email = '' 
    } = req.body;

    const montoLimpio = parseFloat(monto) || 0;
    if (montoLimpio <= 0) {
      return res.status(400).json({ status: 'error', message: 'Monto inválido para procesar el pago' });
    }

    // Cálculo inverso para transferir la comisión de Stripe (3.6% + $3.00 MXN + IVA 16%)
    const totalConComision = (montoLimpio + 3.48) / 0.95824;
    const cargoServicio = Math.max(0, Math.round((totalConComision - montoLimpio) * 100) / 100);

    const datosMeta = {
      alumnoId: String(alumnoId || 'ALU-001'),
      nombreAlumno: String(nombreAlumno || 'Alumno'),
      cuentaId: String(cuentaId || 'CTA-001'),
      concepto: String(concepto || 'Abono de Graduación'),
      email: String(email || ''),
      montoNetoAbono: String(montoLimpio)
    };

    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

    const configuracionSesion = {
      line_items: [
        {
          price_data: {
            currency: 'mxn',
            product_data: {
              name: String(concepto),
              description: `Abono de graduación - Alumno: ${nombreAlumno}`,
            },
            unit_amount: Math.round(montoLimpio * 100),
          },
          quantity: 1,
        },
        {
          price_data: {
            currency: 'mxn',
            product_data: {
              name: 'Cargo por servicio digital',
              description: 'Tarifa de procesamiento de pago con tarjeta en línea',
            },
            unit_amount: Math.round(cargoServicio * 100),
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      metadata: datosMeta,
      payment_intent_data: {
        metadata: datosMeta,
        description: `Abono de graduación - ${nombreAlumno}`,
      },
      success_url: `${baseUrl}/?pago=exito&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/?pago=cancelado`,
    };

    if (email && typeof email === 'string' && email.includes('@')) {
      configuracionSesion.customer_email = email.trim();
    }

    const session = await stripe.checkout.sessions.create(configuracionSesion);

    return res.status(200).json({ status: 'ok', url: session.url, id: session.id });
  } catch (error) {
    console.error('❌ Error creando sesión de Stripe:', error.message);
    return res.status(500).json({ status: 'error', message: error.message });
  }
};

// Registrar un nuevo pago manual
exports.crearPago = async (req, res) => {
  try {
    const { cuenta, monto, alumno } = req.body;
    const montoNum = limpiarNumero(monto);

    const nuevoPago = new Pago(req.body);
    await nuevoPago.save();

    if (cuenta || alumno) {
      const condiciones = [];
      if (cuenta) {
        condiciones.push({ id: cuenta });
        if (mongoose.Types.ObjectId.isValid(cuenta)) condiciones.unshift({ _id: cuenta });
      }
      if (alumno) {
        condiciones.push({ alumno: new RegExp(alumno, 'i') }, { nombre: new RegExp(alumno, 'i') });
      }

      let cuentaDoc = await Cuenta.findOne({ $or: condiciones });
      if (!cuentaDoc && mongoose.connection.readyState === 1) {
        cuentaDoc = await Cuenta.findOne();
      }

      if (cuentaDoc) {
        if (!Array.isArray(cuentaDoc.pagos)) {
          cuentaDoc.pagos = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        }
        let asignado = false;
        for (let i = 0; i < 10; i++) {
          if (!cuentaDoc.pagos[i] || limpiarNumero(cuentaDoc.pagos[i]) === 0) {
            cuentaDoc.pagos[i] = montoNum;
            asignado = true;
            break;
          }
        }
        if (!asignado) {
          cuentaDoc.pagos[9] = limpiarNumero(cuentaDoc.pagos[9]) + montoNum;
        }

        const montoTotal = limpiarNumero(cuentaDoc.monto || 11300);
        const totalPagado = cuentaDoc.pagos.reduce((acc, p) => acc + limpiarNumero(p), 0);
        cuentaDoc.saldo = Math.max(0, montoTotal - totalPagado);
        cuentaDoc.pagada = cuentaDoc.saldo <= 0;
        await cuentaDoc.save();
      }
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

  if (event.type === 'checkout.session.completed' || event.type === 'payment_intent.succeeded') {
    let session = event.data.object;
    let metadata = session.metadata || {};

    if ((!metadata.nombreAlumno && !metadata.alumnoId) && session.id && session.id.startsWith('cs_')) {
      try {
        const fullSession = await stripe.checkout.sessions.retrieve(session.id);
        if (fullSession && fullSession.metadata) {
          metadata = fullSession.metadata;
        }
      } catch (e) {
        console.warn('⚠️ No se pudo recuperar metadata de Stripe:', e.message);
      }
    }

    // Si viene el monto neto en metadata se registra el abono real del alumno, evitando abonarle la comisión
    const monto = metadata.montoNetoAbono
      ? parseFloat(metadata.montoNetoAbono)
      : (session.amount_total ? session.amount_total / 100 : (session.amount ? session.amount / 100 : 0));
    
    const customerEmail = (
      metadata.email || 
      session.customer_email || 
      (session.customer_details && session.customer_details.email) || 
      ''
    ).trim().toLowerCase();

    let nombreAlumno = (metadata.nombreAlumno || metadata.alumno || '').trim();
    let cuentaId = metadata.cuentaId || metadata.cuenta_id || '';
    let clienteId = metadata.clienteId || metadata.alumnoId || '';
    const concepto = metadata.concepto || 'Abono en Línea (Stripe)';

    // 1. Persistencia y Descuento en MongoDB Atlas
    let cuentaDoc = null;
    try {
      if (mongoose.connection.readyState === 1) {
        const condiciones = [];
        if (nombreAlumno && nombreAlumno !== 'Alumno') {
          condiciones.push({ alumno: new RegExp(nombreAlumno, 'i') });
        }
        if (cuentaId) {
          condiciones.unshift({ id: cuentaId });
          if (mongoose.Types.ObjectId.isValid(cuentaId)) {
            condiciones.unshift({ _id: cuentaId });
          }
        }

        if (condiciones.length > 0) {
          cuentaDoc = await Cuenta.findOne({ $or: condiciones });
        }
        if (!cuentaDoc) {
          cuentaDoc = await Cuenta.findOne();
        }

        if (cuentaDoc) {
          nombreAlumno = cuentaDoc.alumno || nombreAlumno || 'aaron';
          cuentaId = cuentaDoc.id || String(cuentaDoc._id);

          if (!Array.isArray(cuentaDoc.pagos) || cuentaDoc.pagos.length !== 10) {
            cuentaDoc.pagos = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
          }

          let asignado = false;
          for (let i = 0; i < 10; i++) {
            if (!cuentaDoc.pagos[i] || limpiarNumero(cuentaDoc.pagos[i]) === 0) {
              cuentaDoc.pagos[i] = monto;
              asignado = true;
              break;
            }
          }
          if (!asignado) {
            cuentaDoc.pagos[9] = limpiarNumero(cuentaDoc.pagos[9]) + monto;
          }

          const montoTotal = limpiarNumero(cuentaDoc.monto || 11300);
          const totalPagado = cuentaDoc.pagos.reduce((acc, p) => acc + limpiarNumero(p), 0);
          cuentaDoc.saldo = Math.max(0, montoTotal - totalPagado);
          cuentaDoc.pagada = cuentaDoc.saldo <= 0;
          await cuentaDoc.save();
        }

        const nuevoPagoBD = new Pago({
          cuenta: cuentaDoc ? cuentaDoc._id : (cuentaId || 'CTA-001'),
          cliente: clienteId || 'ALU-001',
          monto: monto,
          metodoPago: 'stripe',
          notas: `Stripe: ${session.id} | Alumno: ${nombreAlumno} | Email: ${customerEmail}`
        });
        await nuevoPagoBD.save();
      }
    } catch (dbError) {
      console.error('❌ Error guardando en base de datos:', dbError.message);
    }

    // 2. Reflejo inmediato en la memoria compartida
    if (global.datosCompartidos) {
      const saldos = global.datosCompartidos.saldos || [];
      let saldoEncontrado = saldos.find(s => 
        (cuentaId && (s.id === cuentaId || s._id === cuentaId)) ||
        (nombreAlumno && s.alumno && s.alumno.toLowerCase() === nombreAlumno.toLowerCase())
      ) || saldos[0];

      if (saldoEncontrado) {
        if (!Array.isArray(saldoEncontrado.pagos)) {
          saldoEncontrado.pagos = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        }
        let asignado = false;
        for (let i = 0; i < 10; i++) {
          if (!saldoEncontrado.pagos[i] || limpiarNumero(saldoEncontrado.pagos[i]) === 0) {
            saldoEncontrado.pagos[i] = monto;
            asignado = true;
            break;
          }
        }
        if (!asignado) {
          saldoEncontrado.pagos[9] = limpiarNumero(saldoEncontrado.pagos[9]) + monto;
        }

        const montoTotalOriginal = limpiarNumero(saldoEncontrado.monto || 11300);
        const totalAbonado = saldoEncontrado.pagos.reduce((acc, p) => acc + limpiarNumero(p), 0);
        const saldoFinal = Math.max(0, montoTotalOriginal - totalAbonado);

        saldoEncontrado.saldoPendiente = saldoFinal;
        saldoEncontrado.saldo = saldoFinal;
      }

      const nuevoFolioNum = (global.datosCompartidos.pagos || []).length + 1;
      const folioId = 'PAG-' + String(nuevoFolioNum).padStart(3, '0');

      if (!Array.isArray(global.datosCompartidos.pagos)) {
        global.datosCompartidos.pagos = [];
      }
      global.datosCompartidos.pagos.unshift({
        id: folioId,
        folio: folioId,
        alumno: nombreAlumno || 'aaron',
        concepto: concepto,
        monto: monto,
        montoAbonado: monto,
        fecha: new Date().toISOString().split('T')[0],
        metodo: 'Tarjeta (Stripe)',
        estado: 'Completado'
      });
    }
  }

  return res.status(200).json({ received: true });
};

// Obtener todos los pagos
exports.obtenerPagos = async (req, res) => {
  try {
    if (mongoose.connection.readyState === 1) {
      const pagos = await Pago.find().sort({ createdAt: -1 });
      return res.status(200).json({ status: 'ok', data: pagos });
    }
    const pagosMemoria = (global.datosCompartidos && global.datosCompartidos.pagos) || [];
    res.status(200).json({ status: 'ok', data: pagosMemoria });
  } catch (error) {
    const pagosMemoria = (global.datosCompartidos && global.datosCompartidos.pagos) || [];
    res.status(200).json({ status: 'ok', data: pagosMemoria });
  }
};

// Obtener historial por cuenta
exports.obtenerPagosPorCuenta = async (req, res) => {
  try {
    const { cuentaId } = req.params;
    const pagos = await Pago.find({ cuenta: cuentaId }).sort({ createdAt: -1 });
    res.status(200).json({ status: 'ok', totalPagos: pagos.length, data: pagos });
  } catch (error) {
    res.status(400).json({ status: 'error', message: error.message });
  }
};

// Actualizar un pago
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
      { $inc: { saldo: pagoAEliminar.monto } }
    );
    await Pago.findByIdAndDelete(id);

    res.status(200).json({ status: 'ok', message: 'Pago cancelado y saldo restablecido' });
  } catch (error) {
    res.status(400).json({ status: 'error', message: error.message });
  }
};