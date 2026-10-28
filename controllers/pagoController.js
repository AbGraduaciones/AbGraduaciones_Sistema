const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const Pago = require('../models/Pago');
const Cuenta = require('../models/Cuenta');
const mongoose = require('mongoose');

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

    const datosMeta = {
      alumnoId: String(alumnoId || 'ALU-001'),
      nombreAlumno: String(nombreAlumno || 'Alumno'),
      cuentaId: String(cuentaId || 'CTA-001'),
      concepto: String(concepto || 'Abono de Graduación'),
      email: String(email || '')
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

    const monto = session.amount_total 
      ? session.amount_total / 100 
      : (session.amount ? session.amount / 100 : 0);
    
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

    if (!nombreAlumno && global.datosCompartidos && Array.isArray(global.datosCompartidos.alumnos)) {
      const alumnoPorCorreo = global.datosCompartidos.alumnos.find(a => 
        (a.correo || a.email || '').trim().toLowerCase() === customerEmail
      );
      if (alumnoPorCorreo) {
        nombreAlumno = alumnoPorCorreo.nombre || alumnoPorCorreo.nombreCompleto || '';
        clienteId = clienteId || alumnoPorCorreo.id || alumnoPorCorreo.folio || '';
      }
    }

    if (!nombreAlumno) {
      nombreAlumno = (session.customer_details && session.customer_details.name) 
        ? session.customer_details.name.trim() 
        : 'Alumno';
    }

    // 1. Sincronización en memoria compartida
    if (global.datosCompartidos) {
      const nuevoFolioNum = (global.datosCompartidos.pagos || []).length + 1;
      const folioId = 'PAG-' + String(nuevoFolioNum).padStart(3, '0');

      const saldos = global.datosCompartidos.saldos || [];
      let saldoEncontrado = saldos.find(s => {
        const idMatch = cuentaId && ((s.id && s.id === cuentaId) || (s._id && String(s._id) === String(cuentaId)));
        const alumnoIdMatch = clienteId && ((s.clienteId && s.clienteId === clienteId) || (s.alumnoId && s.alumnoId === clienteId));
        
        const nombreS = (s.alumno || s.nombre || s.nombreAlumno || '').trim().toLowerCase();
        const nombreM = nombreAlumno.toLowerCase();
        const nameMatch = nombreS && (nombreS === nombreM || nombreS.includes(nombreM) || nombreM.includes(nombreS));

        const emailS = (s.correo || s.email || '').trim().toLowerCase();
        const emailMatch = customerEmail && emailS && emailS === customerEmail;

        return idMatch || alumnoIdMatch || nameMatch || emailMatch;
      });

      if (!saldoEncontrado && saldos.length === 1) {
        saldoEncontrado = saldos[0];
      }

      const nombreFinalHistorial = saldoEncontrado ? (saldoEncontrado.alumno || saldoEncontrado.nombre || nombreAlumno) : nombreAlumno;

      const pagoFrontend = {
        id: folioId,
        folio: folioId,
        alumno: nombreFinalHistorial,
        concepto: concepto,
        monto: monto,
        montoAbonado: monto,
        fecha: new Date().toISOString().split('T')[0],
        metodo: 'Tarjeta (Stripe)',
        estado: 'Completado'
      };

      if (!Array.isArray(global.datosCompartidos.pagos)) {
        global.datosCompartidos.pagos = [];
      }
      global.datosCompartidos.pagos.unshift(pagoFrontend);

      if (saldoEncontrado) {
        if (!Array.isArray(saldoEncontrado.pagos)) {
          saldoEncontrado.pagos = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        }

        let asignado = false;
        for (let i = 0; i < 10; i++) {
          const valorActual = saldoEncontrado.pagos[i] || saldoEncontrado[`pago${i + 1}`];
          if (!valorActual || Number(valorActual) === 0 || valorActual === '-') {
            saldoEncontrado.pagos[i] = monto;
            saldoEncontrado[`pago${i + 1}`] = monto;
            asignado = true;
            break;
          }
        }
        if (!asignado) {
          saldoEncontrado.pagos[9] = (parseFloat(saldoEncontrado.pagos[9]) || 0) + monto;
          saldoEncontrado['pago10'] = saldoEncontrado.pagos[9];
        }

        const montoTotal = Number(saldoEncontrado.montoTotal || saldoEncontrado.total || saldoEncontrado.monto || 0);
        const totalAbonado = saldoEncontrado.pagos.reduce((acc, curr) => acc + (Number(curr) || 0), 0);

        saldoEncontrado.totalPagado = totalAbonado;
        saldoEncontrado.totalAbonado = totalAbonado;
        saldoEncontrado.saldoPendiente = Math.max(0, montoTotal - totalAbonado);
        saldoEncontrado.saldo = saldoEncontrado.saldoPendiente;
      }
    }

    // 2. Persistencia en MongoDB
    try {
      const nuevoPagoBD = new Pago({
        cuenta: cuentaId || 'CTA-001',
        cliente: clienteId || 'ALU-001',
        monto: monto,
        metodoPago: 'stripe',
        notas: `Stripe Session: ${session.id} | Email: ${customerEmail}`
      });
      await nuevoPagoBD.save();

      const condiciones = [
        { alumno: new RegExp(nombreAlumno, 'i') },
        { nombre: new RegExp(nombreAlumno, 'i') }
      ];

      if (customerEmail) {
        condiciones.push({ correo: customerEmail }, { email: customerEmail });
      }

      if (cuentaId) {
        condiciones.unshift({ id: cuentaId });
        if (mongoose.Types.ObjectId.isValid(cuentaId)) {
          condiciones.unshift({ _id: cuentaId });
        }
      }

      await Cuenta.findOneAndUpdate(
        { $or: condiciones },
        { 
          $inc: { saldo: -Number(monto), saldoPendiente: -Number(monto), totalPagado: Number(monto) },
          $push: { pagosHistorial: nuevoPagoBD._id }
        },
        { new: true }
      );
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
      { $inc: { saldo: pagoAEliminar.monto, saldoPendiente: pagoAEliminar.monto } }
    );
    await Pago.findByIdAndDelete(id);

    res.status(200).json({ status: 'ok', message: 'Pago cancelado y saldo restablecido' });
  } catch (error) {
    res.status(400).json({ status: 'error', message: error.message });
  }
};