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

// Función auxiliar para aplicar el abono y descontar el saldo en MongoDB Atlas
async function aplicarAbonoACuenta({ cuentaId, alumnoId, nombreAlumno, monto, concepto, sessionId, customerEmail }) {
  if (mongoose.connection.readyState !== 1) return null;

  const condiciones = [];

  // 1. Búsqueda por _id de MongoDB
  if (cuentaId && mongoose.Types.ObjectId.isValid(cuentaId)) {
    condiciones.push({ _id: new mongoose.Types.ObjectId(cuentaId) });
  }

  // 2. Búsqueda por id personalizado (String)
  if (cuentaId) {
    condiciones.push({ id: String(cuentaId) });
  }

  // 3. Búsqueda por ID de Alumno / Cliente
  if (alumnoId) {
    condiciones.push({ cliente: String(alumnoId) });
    condiciones.push({ id: String(alumnoId) });
  }

  // 4. Búsqueda por nombre del alumno (insensible a mayúsculas/minúsculas)
  if (nombreAlumno && nombreAlumno !== 'Alumno') {
    const nombreLimpio = nombreAlumno.trim();
    condiciones.push({ alumno: new RegExp(nombreLimpio, 'i') });
    // Búsqueda tolerante de la primera palabra por si hay discrepancias de apellidos o acentos
    const primerNombre = nombreLimpio.split(' ')[0];
    if (primerNombre.length > 2) {
      condiciones.push({ alumno: new RegExp(primerNombre, 'i') });
    }
  }

  let cuentaDoc = null;
  if (condiciones.length > 0) {
    cuentaDoc = await Cuenta.findOne({ $or: condiciones });
  }

  if (!cuentaDoc) {
    console.warn(`⚠️ No se encontró la cuenta con los criterios proporcionados. Criterios:`, { cuentaId, alumnoId, nombreAlumno });
    return null;
  }

  // Asegurar que el arreglo de pagos tenga 10 posiciones numéricas
  if (!Array.isArray(cuentaDoc.pagos) || cuentaDoc.pagos.length !== 10) {
    const pagosActuales = Array.isArray(cuentaDoc.pagos) ? cuentaDoc.pagos : [];
    cuentaDoc.pagos = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < Math.min(10, pagosActuales.length); i++) {
      cuentaDoc.pagos[i] = limpiarNumero(pagosActuales[i]);
    }
  }

  // Asignar el abono en el siguiente pago disponible (del 1 al 10)
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

  // Recalcular saldo total pendiente
  const montoTotal = limpiarNumero(cuentaDoc.monto || 11300);
  const totalPagado = cuentaDoc.pagos.reduce((acc, p) => acc + limpiarNumero(p), 0);
  cuentaDoc.saldo = Math.max(0, montoTotal - totalPagado);
  cuentaDoc.pagada = cuentaDoc.saldo <= 0;

  // AVISO EXPLICITO A MONGOOSE: Forzar guardado de campos mutados
  cuentaDoc.markModified('pagos');
  cuentaDoc.markModified('saldo');
  await cuentaDoc.save();

  console.log(`✅ Saldo descontado exitosamente en MongoDB Atlas para ${cuentaDoc.alumno}: Nuevo Saldo = $${cuentaDoc.saldo}`);

  // Registrar el comprobante en la colección de Pagos si no existe previamente
  const yaExistePago = await Pago.findOne({
    $or: [
      { notas: new RegExp(sessionId || '---', 'i') }
    ]
  });

  if (!yaExistePago) {
    const nuevoPagoBD = new Pago({
      cuenta: cuentaDoc._id,
      cliente: alumnoId || cuentaDoc.cliente || 'ALU-001',
      alumno: cuentaDoc.alumno,
      concepto: concepto || 'Abono en Línea (Stripe)',
      monto: monto,
      fecha: new Date(),
      metodoPago: 'stripe',
      notas: `Stripe: ${sessionId || 'MANUAL'} | Alumno: ${cuentaDoc.alumno} | Email: ${customerEmail || ''}`
    });
    await nuevoPagoBD.save();
  }

  // Reflejar inmediatamente en la memoria global
  if (global.datosCompartidos) {
    const saldos = global.datosCompartidos.saldos || [];
    let saldoEncontrado = saldos.find(s => 
      String(s._id) === String(cuentaDoc._id) || 
      String(s.id) === String(cuentaDoc.id) ||
      (s.alumno && s.alumno.toLowerCase() === cuentaDoc.alumno.toLowerCase())
    );

    if (saldoEncontrado) {
      saldoEncontrado.pagos = [...cuentaDoc.pagos];
      saldoEncontrado.saldo = cuentaDoc.saldo;
      saldoEncontrado.saldoPendiente = cuentaDoc.saldo;
    }

    const nuevoFolioNum = (global.datosCompartidos.pagos || []).length + 1;
    const folioId = 'PAG-' + String(nuevoFolioNum).padStart(3, '0');

    if (!Array.isArray(global.datosCompartidos.pagos)) {
      global.datosCompartidos.pagos = [];
    }

    const pagoYaEnMemoria = global.datosCompartidos.pagos.some(p => p.folio === sessionId || p.id === sessionId);
    if (!pagoYaEnMemoria) {
      global.datosCompartidos.pagos.unshift({
        id: folioId,
        folio: folioId,
        alumno: cuentaDoc.alumno,
        concepto: concepto || 'Abono en Línea (Stripe)',
        monto: monto,
        montoAbonado: monto,
        fecha: new Date().toISOString().split('T')[0],
        metodo: 'Tarjeta (Stripe)',
        estado: 'Completado'
      });
    }
  }

  return cuentaDoc;
}

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
      await aplicarAbonoACuenta({
        cuentaId: cuenta,
        nombreAlumno: alumno,
        monto: montoNum,
        concepto: req.body.concepto || 'Abono Manual',
        customerEmail: req.body.email || ''
      });
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

    const monto = metadata.montoNetoAbono
      ? parseFloat(metadata.montoNetoAbono)
      : (session.amount_total ? session.amount_total / 100 : (session.amount ? session.amount / 100 : 0));
    
    const customerEmail = (
      metadata.email || 
      session.customer_email || 
      (session.customer_details && session.customer_details.email) || 
      ''
    ).trim().toLowerCase();

    const nombreAlumno = (metadata.nombreAlumno || metadata.alumno || '').trim();
    const cuentaId = metadata.cuentaId || metadata.cuenta_id || '';
    const alumnoId = metadata.alumnoId || metadata.clienteId || '';
    const concepto = metadata.concepto || 'Abono en Línea (Stripe)';

    try {
      await aplicarAbonoACuenta({
        cuentaId,
        alumnoId,
        nombreAlumno,
        monto,
        concepto,
        sessionId: session.id,
        customerEmail
      });
    } catch (dbError) {
      console.error('❌ Error guardando abono en base de datos:', dbError.message);
    }
  }

  return res.status(200).json({ received: true });
};

// Exportar la función para uso directo en rutas auxiliares
exports.aplicarAbonoACuenta = aplicarAbonoACuenta;

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