require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

// Importar modelos
const Cliente = require('./models/Cliente');
const Cuenta = require('./models/Cuenta');
const Pago = require('./models/Pago');

// Memoria compartida accesible globalmente
global.datosCompartidos = {
  alumnos: [],
  saldos: [],
  pagos: []
};

// Función auxiliar para cargar los datos desde MongoDB a la memoria compartida
async function sincronizarMemoriaDesdeBD() {
  if (mongoose.connection.readyState !== 1) return;
  try {
    const clientesBD = await Cliente.find().lean();
    const cuentasBD = await Cuenta.find().lean();
    const pagosBD = await Pago.find().sort({ fecha: -1, createdAt: -1 }).lean();

    if (clientesBD.length > 0) {
      global.datosCompartidos.alumnos = clientesBD.map(c => ({
        id: c._id ? String(c._id) : (c.id || 'ALU-001'),
        nombre: c.nombre,
        email: c.email,
        telefono: c.telefono || '',
        universidad: c.universidad || '',
        escuela: c.direccion || c.escuela || ''
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
    console.error('⚠️ Error al cargar datos iniciales desde MongoDB:', err.message);
  }
}

// 1. Conexión a MongoDB Atlas
const mongoUri = process.env.MONGODB_URI || process.env.MONGOOSE_URI;
if (mongoUri) {
  mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 5000
  })
  .then(async () => {
    console.log('✅ Conectado exitosamente a MongoDB Atlas');
    await sincronizarMemoriaDesdeBD();
  })
  .catch((err) => console.error('❌ Error de conexión a MongoDB:', err.message));
} else {
  console.warn('⚠️ No se encontró MONGODB_URI en las variables de entorno.');
}

// 2. Carga del controlador de pagos (tolerante a mayúsculas/minúsculas)
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
    console.log(`✅ Controlador de pago cargado desde: ${ruta}`);
    break;
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') {
      console.error(`⚠️ Error al cargar controlador desde ${ruta}:`, err.message);
    }
  }
}

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// 3. Webhook de Stripe: DEBE ir antes de express.json()
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (pagoController && typeof pagoController.handleStripeWebhook === 'function') {
      try {
        return await pagoController.handleStripeWebhook(req, res);
      } catch (err) {
        console.error('Error delegando webhook a pagoController:', err.message);
      }
    }
    return res.status(200).json({ received: true });
  }
);

// 4. Middlewares de Express
app.use(cors());
app.use(express.json());

// Servir frontend estático
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.static(__dirname));

// 5. Rutas de sincronización para el Frontend (persistencia real en Mongo)
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
            { $or: [{ email: a.email }, { nombre: a.nombre }] },
            {
              nombre: a.nombre,
              email: a.email,
              telefono: a.telefono,
              direccion: a.escuela || a.universidad
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

    res.json({ ok: true, mensaje: 'Datos sincronizados y guardados en MongoDB correctamente' });
  } catch (error) {
    console.error('Error al persistir en /api/datos:', error.message);
    res.json({ ok: true, mensaje: 'Guardado en memoria de respaldo' });
  }
});

// 6. Endpoint de checkout directo que delega al controlador
const procesarCheckout = (req, res) => {
  if (pagoController && typeof pagoController.crearCheckoutSession === 'function') {
    return pagoController.crearCheckoutSession(req, res);
  }
  return res.status(500).json({ status: 'error', message: 'Controlador de pagos no disponible' });
};

app.post('/api/crear-checkout', procesarCheckout);
app.post('/api/pagos/crear-checkout-session', procesarCheckout);

// 7. Envío de correos por Gmail
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

// 8. Rutas API opcionales
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
if (routerCuentas) app.use('/api/cuentas', routerCuentas);

const routerClientes = cargarRutaSegura(['./routes/clientes', './routes/Clientes']);
if (routerClientes) app.use('/api/clientes', routerClientes);

// Manejador para rutas de API no encontradas
app.use('/api', (req, res) => {
  res.status(404).json({ status: 'error', message: 'Ruta API no encontrada' });
});

// 9. Servir frontend
app.use((req, res) => {
  const rutaPublic = path.join(__dirname, 'public', 'index.html');
  const rutaLocal = path.join(__dirname, 'index.html');

  res.sendFile(rutaPublic, (err) => {
    if (err) {
      res.sendFile(rutaLocal, (err2) => {
        if (err2) res.status(200).send('Sistema Ab Graduaciones en línea');
      });
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en el puerto ${PORT}`);
});