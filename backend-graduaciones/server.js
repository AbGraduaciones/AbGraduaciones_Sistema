require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

// Memoria compartida accesible globalmente
global.datosCompartidos = {
  alumnos: [],
  saldos: [],
  pagos: []
};

// 1. Conexión a MongoDB Atlas
const mongoUri = process.env.MONGODB_URI || process.env.MONGOOSE_URI;
if (mongoUri) {
  mongoose.connect(mongoUri, {
    serverSelectionTimeoutMS: 5000
  })
  .then(() => console.log('✅ Conectado exitosamente a MongoDB Atlas'))
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
      console.error(`❌ Error en verificación de webhook: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const metadata = session.metadata || {};
      const monto = session.amount_total ? session.amount_total / 100 : 0;
      const nombreAlumno = metadata.nombreAlumno || (session.customer_details && session.customer_details.name) || 'Alumno';
      const cuentaId = metadata.cuentaId || `CTA-${nombreAlumno}`;
      const concepto = metadata.concepto || 'Abono en Línea (Stripe)';

      const nuevoFolioNum = (global.datosCompartidos.pagos || []).length + 1;
      const folioId = 'PAG-' + String(nuevoFolioNum).padStart(3, '0');

      const nuevoPago = {
        id: folioId,
        alumno: nombreAlumno,
        concepto: concepto,
        monto: monto,
        fecha: new Date().toISOString().split('T')[0],
        metodo: 'Tarjeta (Stripe)',
        estado: 'Completado'
      };

      global.datosCompartidos.pagos.unshift(nuevoPago);

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
        console.log(`✅ Pago aplicado en memoria para: ${saldoEncontrado.alumno}`);
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

// 5. Rutas de sincronización para el Frontend
app.get('/api/datos', (req, res) => {
  res.json(global.datosCompartidos);
});

app.post('/api/datos', (req, res) => {
  const { alumnos, saldos, pagos } = req.body;
  if (alumnos) global.datosCompartidos.alumnos = alumnos;
  if (saldos) global.datosCompartidos.saldos = saldos;
  if (pagos) global.datosCompartidos.pagos = pagos;
  res.json({ ok: true, mensaje: 'Datos sincronizados correctamente' });
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

// Manejador para rutas de API no encontradas (compatible con Express 5)
app.use('/api', (req, res) => {
  res.status(404).json({ status: 'error', message: 'Ruta API no encontrada' });
});

// 9. Servir frontend (compatible con Express 5)
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