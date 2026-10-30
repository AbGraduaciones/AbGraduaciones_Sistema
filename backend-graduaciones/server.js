require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

// Almacén temporal en memoria para códigos OTP de acceso
// Formato: { "alumnoId_o_email": { codigo: "123456", expira: 1234567890 } }
const codigosOtpTemporales = new Map();

// Middleware de autenticación básica (Basic Auth exclusivo para el Panel de Administrador)
const requireAuth = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Panel de Administrador"');
    return res.status(401).send('Acceso denegado: se requieren credenciales');
  }

  const authData = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
  const usuario = authData[0];
  const password = authData[1];

  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASS;

  if (usuario === adminUser && password === adminPass) {
    return next();
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="Panel de Administrador"');
  return res.status(401).send('Acceso denegado: usuario o contraseña incorrectos');
};

// Carga tolerante de modelos
const cargarModelo = (rutas) => {
  for (const r of rutas) {
    try {
      return require(r);
    } catch (e) {
      if (e.code !== 'MODULE_NOT_FOUND') {
        console.warn(`Aviso al cargar modelo ${r}:`, e.message);
      }
    }
  }
  return null;
};

const Cliente = cargarModelo(['./models/Cliente', './models/cliente', './models/Clientes', './models/clientes']) || mongoose.model('Cliente', new mongoose.Schema({}, { strict: false }));
const Cuenta = cargarModelo(['./models/Cuenta', './models/cuenta', './models/Cuentas', './models/cuentas']) || mongoose.model('Cuenta', new mongoose.Schema({}, { strict: false }));
const Pago = cargarModelo(['./models/Pago', './models/pago', './models/Pagos', './models/pagos']) || mongoose.model('Pago', new mongoose.Schema({}, { strict: false }));

// Memoria compartida accesible globalmente
global.datosCompartidos = {
  alumnos: [],
  saldos: [],
  pagos: []
};

// Sincronización desde MongoDB Atlas hacia la Memoria Global
async function sincronizarMemoriaDesdeBD() {
  if (mongoose.connection.readyState !== 1) return;
  try {
    const clientesBD = await Cliente.find().lean();
    const cuentasBD = await Cuenta.find().lean();
    const pagosBD = await Pago.find().sort({ fecha: -1, createdAt: -1 }).lean();

    if (clientesBD.length > 0) {
      global.datosCompartidos.alumnos = clientesBD.map(c => ({
        id: c.id ? String(c.id) : (c._id ? String(c._id) : '1001'),
        nombre: c.nombre,
        email: c.email,
        telefono: c.telefono || '',
        universidad: c.universidad || '',
        facultad: c.facultad || '',
        escuela: c.facultad || c.universidad || c.escuela || ''
      }));
    } else {
      global.datosCompartidos.alumnos = [];
    }

    if (cuentasBD.length > 0) {
      global.datosCompartidos.saldos = cuentasBD.map(cta => {
        const montoTotal = Number(cta.monto) || 0;
        const pagosArr = Array.isArray(cta.pagos) && cta.pagos.length === 10 ? cta.pagos : [0,0,0,0,0,0,0,0,0,0];
        const pagado = pagosArr.reduce((acc, val) => acc + (Number(val) || 0), 0);
        const saldoFinal = Math.max(0, montoTotal - pagado);

        return {
          id: cta.id || String(cta._id),
          _id: String(cta._id),
          cliente: cta.cliente ? String(cta.cliente) : '',
          alumno: cta.alumno,
          paquete: cta.paquete,
          monto: montoTotal,
          saldo: saldoFinal,
          saldoPendiente: saldoFinal,
          pagos: pagosArr,
          entregas: cta.entregas || {},
          eleccionEspecial: cta.eleccionEspecial || '',
          esContadoEfectivo: Boolean(cta.esContadoEfectivo)
        };
      });
    } else {
      global.datosCompartidos.saldos = [];
    }

    if (pagosBD.length > 0) {
      global.datosCompartidos.pagos = pagosBD.map((p, idx) => ({
        id: p._id ? String(p._id) : (p.id ? String(p.id) : `PAG-${String(idx + 1).padStart(3, '0')}`),
        folio: p._id ? String(p._id) : (p.id ? String(p.id) : `PAG-${String(idx + 1).padStart(3, '0')}`),
        alumno: p.alumno || 'Alumno',
        concepto: p.concepto || 'Abono de Graduación',
        monto: Number(p.monto) || 0,
        montoAbonado: Number(p.monto) || 0,
        fecha: p.fecha ? new Date(p.fecha).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
        metodo: p.metodoPago === 'stripe' ? 'Tarjeta (Stripe)' : (p.metodoPago || p.metodo || 'Efectivo'),
        estado: 'Completado'
      }));
    } else {
      global.datosCompartidos.pagos = [];
    }
    console.log('✅ Sincronización exitosa: MongoDB -> Memoria Global');
  } catch (err) {
    console.error('⚠️ Error al sincronizar desde MongoDB:', err.message);
  }
}

// 1. Conexión a MongoDB
const mongoUri = process.env.MONGODB_URI || process.env.MONGOOSE_URI;
if (mongoUri) {
  mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 })
    .then(async () => {
      console.log('✅ Conectado exitosamente a MongoDB Atlas');
      await sincronizarMemoriaDesdeBD();
    })
    .catch((err) => console.error('❌ Error de conexión a MongoDB:', err.message));
}

// 2. Controlador de pagos
let pagoController = null;
const rutasPosibles = [
  './controllers/pagoController',
  './controllers/PagoController',
  '../controllers/pagoController',
  '../controllers/PagoController'
];

for (const ruta of rutasPosibles) {
  try {
    pagoController = require(ruta);
    console.log(`✅ Controlador cargado desde: ${ruta}`);
    break;
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') {
      console.error(`⚠️ Error al cargar controlador desde ${ruta}:`, err.message);
    }
  }
}

const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

// 3. Webhook de Stripe
app.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  console.log('🔔 [STRIPE WEBHOOK RECIBIDO] Entrada detectada en /webhook a las:', new Date().toISOString());

  if (pagoController && typeof pagoController.handleStripeWebhook === 'function') {
    try {
      const resultado = await pagoController.handleStripeWebhook(req, res);
      await sincronizarMemoriaDesdeBD();
      return resultado;
    } catch (err) {
      console.error('Error delegando webhook:', err.message);
    }
  }
  return res.status(200).json({ received: true });
});

// 4. Middlewares de datos
app.use(cors());
app.use(express.json());

// 5. Rutas de datos públicas
app.get('/api/datos', async (req, res) => {
  if (mongoose.connection.readyState === 1) {
    await sincronizarMemoriaDesdeBD();
  }
  res.json(global.datosCompartidos);
});

app.post('/api/datos', async (req, res) => {
  try {
    const { alumnos, saldos, pagos } = req.body;

    if (Array.isArray(alumnos)) {
      global.datosCompartidos.alumnos = alumnos;
      if (mongoose.connection.readyState === 1) {
        const idsVigentesAlumnos = alumnos.map(a => String(a.id)).filter(Boolean);
        await Cliente.deleteMany({ id: { $nin: idsVigentesAlumnos } });

        for (const a of alumnos) {
          await Cliente.findOneAndUpdate(
            { id: String(a.id) },
            {
              id: String(a.id),
              nombre: a.nombre,
              email: a.email,
              telefono: a.telefono,
              universidad: a.universidad,
              facultad: a.facultad || a.escuela,
              escuela: a.escuela || a.facultad
            },
            { upsert: true, new: true }
          );
        }
      }
    }

    if (Array.isArray(saldos)) {
      if (mongoose.connection.readyState === 1) {
        const idsVigentesSaldos = saldos.map(s => String(s.id || s._id)).filter(Boolean);
        const nombresAlumnosVigentes = saldos.map(s => s.alumno).filter(Boolean);
        const objectIdsValidos = idsVigentesSaldos.filter(id => mongoose.Types.ObjectId.isValid(id)).map(id => new mongoose.Types.ObjectId(id));

        await Cuenta.deleteMany({
          $and: [
            { id: { $nin: idsVigentesSaldos } },
            { _id: { $nin: objectIdsValidos } },
            { alumno: { $nin: nombresAlumnosVigentes } }
          ]
        });

        for (const s of saldos) {
          const cuentaExistente = await Cuenta.findOne({
            $or: [
              ...(s._id && mongoose.Types.ObjectId.isValid(s._id) ? [{ _id: new mongoose.Types.ObjectId(s._id) }] : []),
              { id: s.id },
              { alumno: new RegExp(`^${s.alumno}$`, 'i') }
            ]
          }).lean();

          let pagosArr = Array.isArray(s.pagos) ? [...s.pagos] : [0,0,0,0,0,0,0,0,0,0];

          if (cuentaExistente && Array.isArray(cuentaExistente.pagos)) {
            for (let i = 0; i < 10; i++) {
              const valBD = Number(cuentaExistente.pagos[i]) || 0;
              const valLocal = Number(pagosArr[i]) || 0;
              pagosArr[i] = Math.max(valBD, valLocal);
            }
          }

          const montoTotal = Number(s.monto) || (cuentaExistente ? cuentaExistente.monto : 11300);
          const pagado = pagosArr.reduce((acc, val) => acc + (Number(val) || 0), 0);
          const saldoFinal = Math.max(0, montoTotal - pagado);

          const filtroCuenta = cuentaExistente 
            ? { _id: cuentaExistente._id } 
            : { $or: [{ id: s.id }, { alumno: s.alumno }] };

          await Cuenta.findOneAndUpdate(
            filtroCuenta,
            {
              id: s.id || (cuentaExistente ? cuentaExistente.id : 'CTA-' + Date.now()),
              cliente: s.cliente || (cuentaExistente ? cuentaExistente.cliente : '1001'),
              alumno: s.alumno,
              paquete: s.paquete,
              monto: montoTotal,
              saldo: saldoFinal,
              pagos: pagosArr,
              entregas: s.entregas || {},
              eleccionEspecial: s.eleccionEspecial || (cuentaExistente ? cuentaExistente.eleccionEspecial : ''),
              esContadoEfectivo: Boolean(s.esContadoEfectivo),
              pagada: saldoFinal <= 0
            },
            { upsert: true, new: true }
          );
        }

        await sincronizarMemoriaDesdeBD();
      } else {
        global.datosCompartidos.saldos = saldos;
      }
    }

    if (Array.isArray(pagos)) {
      if (mongoose.connection.readyState === 1) {
        const idsVigentesPagos = pagos.map(p => String(p.id || p._id)).filter(Boolean);
        const objectIdsPagos = idsVigentesPagos.filter(id => mongoose.Types.ObjectId.isValid(id)).map(id => new mongoose.Types.ObjectId(id));

        await Pago.deleteMany({
          $and: [
            { _id: { $nin: objectIdsPagos } },
            { id: { $nin: idsVigentesPagos } }
          ]
        });

        await sincronizarMemoriaDesdeBD();
      } else {
        global.datosCompartidos.pagos = pagos;
      }
    }

    res.json({ ok: true, mensaje: 'Datos sincronizados correctamente' });
  } catch (error) {
    console.error('Error al persistir en /api/datos:', error.message);
    res.json({ ok: true, mensaje: 'Guardado en memoria de respaldo' });
  }
});

// 6. Rutas de pagos (Públicas)
const procesarCheckout = (req, res) => {
  if (pagoController && typeof pagoController.crearCheckoutSession === 'function') {
    return pagoController.crearCheckoutSession(req, res);
  }
  return res.status(500).json({ status: 'error', message: 'Controlador de pagos no disponible' });
};

app.post('/api/crear-checkout', procesarCheckout);
app.post('/api/pagos/crear-checkout-session', procesarCheckout);

// Endpoint de verificación y confirmación inmediata al volver de Stripe
app.get('/api/verificar-sesion-stripe/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    if (!sessionId || !sessionId.startsWith('cs_')) {
      return res.status(400).json({ ok: false, error: 'Session ID no válido' });
    }

    if (!stripe) {
      return res.status(500).json({ ok: false, error: 'Stripe no está configurado' });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session || session.payment_status !== 'paid') {
      return res.status(400).json({ ok: false, error: 'El pago aún no figura como liquidado en Stripe' });
    }

    const metadata = session.metadata || {};
    const nombreAlumno = (metadata.nombreAlumno || metadata.alumno || '').trim();
    const cuentaId = metadata.cuentaId || metadata.cuenta_id || '';
    const alumnoId = metadata.alumnoId || metadata.clienteId || '';
    const concepto = metadata.concepto || 'Abono en Línea (Stripe)';
    const monto = metadata.montoNetoAbono 
      ? parseFloat(metadata.montoNetoAbono) 
      : (session.amount_total ? session.amount_total / 100 : 0);

    if (pagoController && typeof pagoController.aplicarAbonoACuenta === 'function') {
      await pagoController.aplicarAbonoACuenta({
        cuentaId,
        alumnoId,
        nombreAlumno,
        monto,
        concepto,
        sessionId: session.id,
        customerEmail: session.customer_email || metadata.email || ''
      });
    }

    if (mongoose.connection.readyState === 1) {
      await sincronizarMemoriaDesdeBD();
    }

    res.json({ ok: true, mensaje: 'Pago verificado y saldo aplicado' });
  } catch (error) {
    console.error('Error al verificar sesión directa:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// 7. Configuración de transporte de correo
let transporter = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
  transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
}

// 8. Generación y Envío de Código de Seguridad (Tolerante: Correo y/o WhatsApp)
app.post('/api/enviar-codigo-seguridad', async (req, res) => {
  try {
    const { email, nombre, alumnoId, codigo: codigoRecibido } = req.body;
    
    // Si el cliente ya generó un código para WhatsApp, usamos ese; si no, creamos uno nuevo
    const codigo = codigoRecibido || Math.floor(100000 + Math.random() * 900000).toString();

    // Guardar en memoria con validez de 15 minutos
    const expiracion = Date.now() + 15 * 60 * 1000;
    if (alumnoId) codigosOtpTemporales.set(String(alumnoId).toLowerCase(), { codigo: String(codigo), expira: expiracion });
    if (email) codigosOtpTemporales.set(String(email).toLowerCase(), { codigo: String(codigo), expira: expiracion });

    // Intentar envío de correo solo si hay credenciales configuradas y se proporcionó un correo
    if (transporter && email) {
      try {
        await transporter.sendMail({
          from: `"Ab Graduaciones" <${process.env.EMAIL_USER}>`,
          to: email,
          subject: 'Tu código de acceso - Ab Graduaciones',
          html: `
            <div style="font-family: Arial, sans-serif; padding: 20px; color: #1e293b;">
              <h2 style="color: #1e3a8a;">Ab Graduaciones</h2>
              <p>Hola <strong>${nombre || 'Alumno'}</strong>,</p>
              <p>Tu código de seguridad para ingresar al portal es:</p>
              <div style="font-size: 28px; font-weight: bold; letter-spacing: 5px; color: #2563eb; margin: 16px 0;">
                ${codigo}
              </div>
              <p style="font-size: 12px; color: #64748b;">Este código es válido por 15 minutos.</p>
            </div>
          `
        });
      } catch (errCorreo) {
        console.warn('⚠️ No se pudo enviar el correo (se continuará con el código generado):', errCorreo.message);
      }
    }

    return res.json({ success: true, codigo, message: 'Código procesado exitosamente' });
  } catch (error) {
    console.error('Error al procesar código de seguridad:', error.message);
    res.status(200).json({ success: true, message: 'Código generado en modo de contingencia' });
  }
});

// 9. Verificación de Código de Seguridad
app.post('/api/verificar-codigo-seguridad', (req, res) => {
  const { alumnoId, email, codigo } = req.body;
  const codigoStr = String(codigo || '').trim();

  const claveAlumno = alumnoId ? String(alumnoId).toLowerCase() : null;
  const claveEmail = email ? String(email).toLowerCase() : null;

  const otpData = (claveAlumno && codigosOtpTemporales.get(claveAlumno)) ||
                  (claveEmail && codigosOtpTemporales.get(claveEmail));

  if (otpData) {
    if (Date.now() > otpData.expira) {
      codigosOtpTemporales.delete(claveAlumno);
      codigosOtpTemporales.delete(claveEmail);
      return res.status(400).json({ success: false, message: 'El código ha expirado. Solicita uno nuevo.' });
    }

    if (otpData.codigo === codigoStr) {
      codigosOtpTemporales.delete(claveAlumno);
      codigosOtpTemporales.delete(claveEmail);
      return res.json({ success: true, message: 'Código verificado con éxito' });
    }
  }

  return res.status(400).json({ success: false, message: 'Código incorrecto o no encontrado' });
});

// 10. Routers auxiliares
const cargarRutaSegura = (rutas) => {
  for (const r of rutas) {
    try {
      return require(r);
    } catch (e) {
      if (e.code !== 'MODULE_NOT_FOUND') {
        console.warn(`Aviso al cargar ruta ${r}:`, e.message);
      }
    }
  }
  return null;
};

const routerPagos = cargarRutaSegura(['./routes/pagoRoutes', './routes/PagoRoutes']);
if (routerPagos) app.use('/api/pagos', routerPagos);

const routerCuentas = cargarRutaSegura(['./routes/cuentas', './routes/Cuentas']);
if (routerCuentas) app.use('/api/cuentas', requireAuth, routerCuentas);

const routerClientes = cargarRutaSegura(['./routes/clientes', './routes/Clientes']);
if (routerClientes) app.use('/api/clientes', requireAuth, routerClientes);

// 11. Archivos estáticos y logotipo
app.get('/logo.png', (req, res) => {
  const posiblesRutasLogo = [
    path.join(process.cwd(), 'public', 'logo.png'),
    path.join(__dirname, 'public', 'logo.png'),
    path.join(__dirname, '..', 'public', 'logo.png'),
    path.join(__dirname, 'logo.png')
  ];

  for (const ruta of posiblesRutasLogo) {
    if (fs.existsSync(ruta)) {
      return res.sendFile(ruta);
    }
  }
  res.status(404).send('Logo no encontrado');
});

app.use(express.static(path.join(process.cwd(), 'public'), { index: false }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const entregarIndex = (res) => {
  const posiblesRutas = [
    path.join(process.cwd(), 'public', 'index.html'),
    path.join(__dirname, 'public', 'index.html'),
    path.join(__dirname, '..', 'public', 'index.html'),
    path.join(__dirname, 'index.html')
  ];

  for (const ruta of posiblesRutas) {
    if (fs.existsSync(ruta)) {
      return res.sendFile(ruta);
    }
  }

  res.status(500).send('Error: no se encontró index.html');
};

// 12. Rutas visuales
app.get('/api/logout', (req, res) => {
  res.setHeader('WWW-Authenticate', 'Basic realm="Panel de Administrador"');
  res.status(401).send('Sesión cerrada');
});

app.get(['/', '/pago', '/portal'], (req, res) => {
  entregarIndex(res);
});

app.get(['/admin', '/admn'], requireAuth, (req, res) => {
  entregarIndex(res);
});

app.use((req, res) => {
  res.redirect('/pago');
});

const servidor = app.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en el puerto ${PORT}`);
});

module.exports = { app, servidor };