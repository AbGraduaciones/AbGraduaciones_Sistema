require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

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

// Sincronización desde MongoDB Atlas
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
    }

    if (cuentasBD.length > 0) {
      global.datosCompartidos.saldos = cuentasBD.map(cta => ({
        id: cta.id || String(cta._id),
        _id: String(cta._id),
        alumno: cta.alumno,
        paquete: cta.paquete,
        monto: cta.monto,
        saldo: cta.saldo !== undefined ? cta.saldo : cta.monto,
        saldoPendiente: cta.saldo !== undefined ? cta.saldo : cta.monto,
        pagos: Array.isArray(cta.pagos) && cta.pagos.length === 10 ? cta.pagos : [0,0,0,0,0,0,0,0,0,0],
        entregas: cta.entregas || {},
        eleccionEspecial: cta.eleccionEspecial || '',
        esContadoEfectivo: Boolean(cta.esContadoEfectivo)
      }));
    }

    if (pagosBD.length > 0) {
      global.datosCompartidos.pagos = pagosBD.map((p, idx) => ({
        id: p._id ? String(p._id) : `PAG-${String(idx + 1).padStart(3, '0')}`,
        folio: p._id ? String(p._id) : `PAG-${String(idx + 1).padStart(3, '0')}`,
        alumno: p.alumno || 'Alumno',
        concepto: p.concepto || 'Abono de Graduación',
        monto: p.monto,
        montoAbonado: p.monto,
        fecha: p.fecha ? new Date(p.fecha).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
        metodo: p.metodoPago === 'stripe' ? 'Tarjeta (Stripe)' : (p.metodoPago || 'Efectivo'),
        estado: 'Completado'
      }));
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

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// 3. Webhook de Stripe
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (pagoController && typeof pagoController.handleStripeWebhook === 'function') {
    try {
      return await pagoController.handleStripeWebhook(req, res);
    } catch (err) {
      console.error('Error delegando webhook:', err.message);
    }
  }
  return res.status(200).json({ received: true });
});

// 4. Middlewares de datos
app.use(cors());
app.use(express.json());

// 5. Rutas de datos públicas (SIN requireAuth para permitir consulta en el portal de alumnos sin pedir contraseña)
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
        for (const a of alumnos) {
          await Cliente.findOneAndUpdate(
            { $or: [{ id: a.id }, { email: a.email }, { nombre: a.nombre }] },
            {
              id: a.id,
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
      global.datosCompartidos.saldos = saldos;
      if (mongoose.connection.readyState === 1) {
        for (const s of saldos) {
          const montoTotal = Number(s.monto) || 11300;
          const pagosArr = Array.isArray(s.pagos) ? s.pagos : [0,0,0,0,0,0,0,0,0,0];
          const pagado = pagosArr.reduce((acc, val) => acc + (Number(val) || 0), 0);
          const saldoFinal = Math.max(0, montoTotal - pagado);

          await Cuenta.findOneAndUpdate(
            { $or: [{ id: s.id }, { alumno: new RegExp(s.alumno, 'i') }] },
            {
              id: s.id,
              cliente: s.id || 'CLIENTE-TEMP',
              alumno: s.alumno,
              paquete: s.paquete,
              monto: montoTotal,
              saldo: saldoFinal,
              pagos: pagosArr,
              entregas: s.entregas || {},
              eleccionEspecial: s.eleccionEspecial || '',
              esContadoEfectivo: Boolean(s.esContadoEfectivo),
              pagada: saldoFinal <= 0
            },
            { upsert: true, new: true }
          );
        }
      }
    }

    if (Array.isArray(pagos)) {
      global.datosCompartidos.pagos = pagos;
    }

    res.json({ ok: true, mensaje: 'Datos sincronizados en MongoDB correctamente' });
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

// 7. Envío de correos (Público para alumnos)
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

app.post('/api/enviar-codigo-seguridad', async (req, res) => {
  try {
    const { email, nombre } = req.body;
    const codigo = Math.floor(100000 + Math.random() * 900000).toString();

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
        </div>
      `
    });

    res.json({ success: true, codigo, message: 'Código enviado exitosamente' });
  } catch (error) {
    console.error('Error al enviar correo:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

// 8. Routers auxiliares
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

// ==========================================
// 9. GESTOR DE ENTREGA DE FRONTEND
// ==========================================
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

// Archivos estáticos auxiliares SIN entregar automáticamente index.html
app.use(express.static(path.join(process.cwd(), 'public'), { index: false }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// PORTAL DEL ALUMNO (PÚBLICO: Raíz y /pago) -> NUNCA pide contraseña
app.get(['/', '/pago', '/portal'], (req, res) => {
  entregarIndex(res);
});

// PANEL DE ADMINISTRADOR (PROTEGIDO: Exige usuario y contraseña obligatoriamente)
app.get(['/admin', '/admn'], requireAuth, (req, res) => {
  entregarIndex(res);
});

// Redirección general: Cualquier otra ruta no especificada va a /pago
app.use((req, res) => {
  res.redirect('/pago');
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en el puerto ${PORT}`);
});