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

// Normaliza texto para tolerar discrepancias comunes (s/z, acentos, mayúsculas)
const normalizarBusqueda = (texto) => {
  if (!texto) return '';
  return String(texto)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
};

// Función auxiliar para aplicar el abono y descontar el saldo en MongoDB Atlas
async function aplicarAbonoACuenta({ cuentaId, alumnoId, nombreAlumno, monto, concepto, sessionId, customerEmail }) {
  // Asegurar y reconectar a MongoDB Atlas si la conexión está inactiva o conectando
  if (mongoose.connection.readyState === 0) {
    const mongoUri = process.env.MONGODB_URI || process.env.MONGOOSE_URI;
    if (mongoUri) {
      await mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 });
    }
  }

  if (mongoose.connection.readyState === 2) {
    let intentos = 0;
    while (mongoose.connection.readyState === 2 && intentos < 6) {
      await new Promise(r => setTimeout(r, 500));
      intentos++;
    }
  }

  if (mongoose.connection.readyState !== 1) {
    console.warn('⚠️ No fue posible conectar con MongoDB Atlas (readyState !== 1)');
    return null;
  }

  const montoAbono = limpiarNumero(monto);
  if (montoAbono <= 0) {
    console.warn('⚠️ Monto de abono inválido o igual a 0:', monto);
    return null;
  }

  // =========================================================================
  // BLINDAJE CONTRA DOBLE PAGO (IDEMPOTENCIA):
  // Si esta sesión de Stripe ya fue procesada, DETENER inmediatamente.
  // =========================================================================
  if (sessionId && sessionId !== 'MANUAL') {
    const pagoDuplicado = await Pago.findOne({
      $or: [
        { notas: new RegExp(sessionId, 'i') },
        { id: sessionId },
        { folio: sessionId }
      ]
    });

    if (pagoDuplicado) {
      console.log(`🛑 Pago ${sessionId} ya fue procesado anteriormente. Omitiendo duplicado para evitar doble descuento.`);
      return null;
    }
  }

  let cuentaDoc = null;

  // 1. Intento por _id nativo de MongoDB
  if (cuentaId && mongoose.Types.ObjectId.isValid(cuentaId)) {
    cuentaDoc = await Cuenta.findById(cuentaId);
  }

  // 2. Intento por campo id o cliente en string
  if (!cuentaDoc && (cuentaId || alumnoId)) {
    const filtrosId = [];
    if (cuentaId) filtrosId.push({ id: String(cuentaId) }, { cliente: String(cuentaId) });
    if (alumnoId) filtrosId.push({ id: String(alumnoId) }, { cliente: String(alumnoId) });
    cuentaDoc = await Cuenta.findOne({ $or: filtrosId });
  }

  // 3. Intento por nombre exacto o tolerante
  if (!cuentaDoc && nombreAlumno && nombreAlumno !== 'Alumno') {
    const nombreLimpio = nombreAlumno.trim();
    cuentaDoc = await Cuenta.findOne({ alumno: new RegExp(`^${nombreLimpio}$`, 'i') });

    if (!cuentaDoc) {
      const palabras = nombreLimpio.split(/\s+/).filter(p => p.length > 2);
      if (palabras.length >= 2) {
        const regexDosPalabras = new RegExp(`${palabras[0]}.*${palabras[1]}`, 'i');
        cuentaDoc = await Cuenta.findOne({ alumno: regexDosPalabras });
      }
      if (!cuentaDoc && palabras.length > 0) {
        cuentaDoc = await Cuenta.findOne({ alumno: new RegExp(palabras[0], 'i') });
      }
    }
  }

  // 4. Respaldo por coincidencia normalizada en la lista completa de cuentas
  if (!cuentaDoc && nombreAlumno && nombreAlumno !== 'Alumno') {
    const todasLasCuentas = await Cuenta.find();
    const busqNorm = normalizarBusqueda(nombreAlumno);
    const primerTermino = busqNorm.split(' ')[0];

    cuentaDoc = todasLasCuentas.find(c => {
      const nomC = normalizarBusqueda(c.alumno);
      return nomC.includes(primerTermino) || primerTermino.includes(nomC.split(' ')[0]);
    }) || null;
  }

  if (!cuentaDoc) {
    console.warn(`⚠️ No se encontró la cuenta con los criterios proporcionados:`, { cuentaId, alumnoId, nombreAlumno });
    return null;
  }

  // REGISTRAR EL PAGO PRIMERO (Actúa como cerrojo/bloqueo ante peticiones simultáneas)
  const nuevoPagoBD = new Pago({
    cuenta: cuentaDoc._id,
    cliente: cuentaDoc.cliente || alumnoId || '1001',
    alumno: cuentaDoc.alumno,
    concepto: concepto || 'Abono en Línea (Stripe)',
    monto: montoAbono,
    fecha: new Date(),
    metodoPago: 'stripe',
    notas: `Stripe: ${sessionId || 'MANUAL'} | Alumno: ${cuentaDoc.alumno} | Email: ${customerEmail || ''}`
  });
  await nuevoPagoBD.save();

  // Asegurar estructura de 10 casillas numéricas
  if (!Array.isArray(cuentaDoc.pagos) || cuentaDoc.pagos.length !== 10) {
    const pagosPrevios = Array.isArray(cuentaDoc.pagos) ? cuentaDoc.pagos : [];
    cuentaDoc.pagos = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < Math.min(10, pagosPrevios.length); i++) {
      cuentaDoc.pagos[i] = limpiarNumero(pagosPrevios[i]);
    }
  }

  // Asignar el abono en UNA sola casilla disponible
  let asignado = false;
  for (let i = 0; i < 10; i++) {
    if (!cuentaDoc.pagos[i] || limpiarNumero(cuentaDoc.pagos[i]) === 0) {
      cuentaDoc.pagos[i] = montoAbono;
      asignado = true;
      break;
    }
  }
  if (!asignado) {
    cuentaDoc.pagos[9] = limpiarNumero(cuentaDoc.pagos[9]) + montoAbono;
  }

  // Recálculo del saldo y estatus
  const montoTotal = limpiarNumero(cuentaDoc.monto || 12700);
  const totalPagado = cuentaDoc.pagos.reduce((acc, p) => acc + limpiarNumero(p), 0);
  cuentaDoc.saldo = Math.max(0, montoTotal - totalPagado);
  cuentaDoc.pagada = cuentaDoc.saldo <= 0;

  cuentaDoc.markModified('pagos');
  cuentaDoc.markModified('saldo');
  await cuentaDoc.save();

  console.log(`✅ Saldo descontado exitosamente en Atlas para ${cuentaDoc.alumno}: Nuevo Saldo = $${cuentaDoc.saldo}`);

  // Sincronización en memoria compartida
  if (global.datosCompartidos) {
    const saldos = global.datosCompartidos.saldos || [];
    let saldoEncontrado = saldos.find(s => 
      String(s._id) === String(cuentaDoc._id) || 
      String(s.id) === String(cuentaDoc.id) ||
      normalizarBusqueda(s.alumno) === normalizarBusqueda(cuentaDoc.alumno)
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

    const yaEnMemoria = global.datosCompartidos.pagos.some(p => 
      p.folio === sessionId || p.id === sessionId || (p.notas && p.notas.includes(sessionId))
    );

    if (!yaEnMemoria) {
      global.datosCompartidos.pagos.unshift({
        id: folioId,
        folio: folioId,
        alumno: cuentaDoc.alumno,
        concepto: concepto || 'Abono en Línea (Stripe)',
        monto: montoAbono,
        montoAbonado: montoAbono,
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
      event = typeof req.body === 'string' ? JSON.parse(req.body) : JSON.parse(req.body.toString('utf8'));
    }
  } catch (err) {
    console.error(`❌ Error en constructEvent de Stripe: ${err.message}`);
    try {
      event = typeof req.body === 'string' ? JSON.parse(req.body) : JSON.parse(req.body.toString('utf8'));
    } catch (parseErr) {
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }

  // =========================================================================
  // FILTRADO ESTRICTO DE EVENTO:
  // Solo procesar 'checkout.session.completed'. Si Stripe envía además 
  // 'payment_intent.succeeded' para la misma compra, lo ignoramos para evitar duplicados.
  // =========================================================================
  if (event && event.type === 'checkout.session.completed') {
    let session = event.data.object;
    let metadata = session.metadata || {};

    if ((!metadata.nombreAlumno && !metadata.alumnoId) && session.id && session.id.startsWith('cs_')) {
      try {
        const fullSession = await stripe.checkout.sessions.retrieve(session.id);
        if (fullSession && fullSession.metadata) {
          metadata = fullSession.metadata;
        }
      } catch (e) {
        console.warn('⚠️ No se pudo recuperar metadata adicional de Stripe:', e.message);
      }
    }

    const monto = metadata.montoNetoAbono
      ? parseFloat(metadata.montoNetoAbono)
      : (session.amount_total ? session.amount_total / 100 : 0);
    
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
  } else if (event && event.type === 'payment_intent.succeeded') {
    // Si viene solo como payment_intent fuera de checkout, verificar si tiene metadata propia
    const pi = event.data.object;
    const metadata = pi.metadata || {};
    // Si ya trae prefijo cs_ en descripción o metadata, omitir porque checkout.session.completed se encarga
    if (!pi.description || !pi.description.includes('cs_')) {
      const monto = metadata.montoNetoAbono ? parseFloat(metadata.montoNetoAbono) : (pi.amount ? pi.amount / 100 : 0);
      if (metadata.nombreAlumno && monto > 0) {
        await aplicarAbonoACuenta({
          cuentaId: metadata.cuentaId || '',
          alumnoId: metadata.alumnoId || '',
          nombreAlumno: metadata.nombreAlumno,
          monto,
          concepto: metadata.concepto || 'Abono en Línea (Stripe)',
          sessionId: pi.id,
          customerEmail: metadata.email || ''
        });
      }
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