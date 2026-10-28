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

// 2. Carga del controlador de pagos
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

// 3. Webhook de Stripe (Debe ir antes de express.json)
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (pagoController && typeof pagoController.handleStripeWebhook === 'function') {
      return await pagoController.handleStripeWebhook(req, res);
    }
    return res.status(200).json({ received: true });
  }
);

// 4. Middlewares de Express
app.use(cors());
app.use(express.json());

// Servir archivos estáticos del frontend
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

// 6. Endpoint de checkout directo (soporta ambas rutas: /api/crear-checkout y /api/pagos/crear-checkout-session)
const ejecutarCheckoutStripe = (req, res) => {
  if (pagoController && typeof pagoController.crearCheckoutSession === 'function') {
    return pagoController.crearCheckoutSession(req, res);
  }
  return res.status(500).json({ status: 'error', message: 'Controlador de pagos no disponible en el servidor' });
};

app.post('/api/crear-checkout', ejecutarCheckoutStripe);
app.post('/api/pagos/crear-checkout-session', ejecutarCheckoutStripe);

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

// 8. Rutas modulares API
try {
  app.use('/api/pagos', require('./routes/pagoRoutes'));
} catch (e) {}
try {
  app.use('/api/cuentas', require('./routes/cuentas'));
} catch (e) {}
try {
  app.use('/api/clientes', require('./routes/clientes'));
} catch (e) {}

// Manejador estricto para que NINGUNA ruta de /api devuelva HTML si falla
app.all('/api/*', (req, res) => {
  res.status(404).json({ status: 'error', message: 'Ruta API no encontrada' });
});

// 9. Servir frontend (únicamente peticiones GET de navegación)
app.get('*', (req, res) => {
  const rutaPublicIndex = path.join(__dirname, 'public', 'index.html');
  const rutaLocalIndex = path.join(__dirname, 'index.html');

  res.sendFile(rutaPublicIndex, (err) => {
    if (err) {
      res.sendFile(rutaLocalIndex, (err2) => {
        if (err2) res.status(200).send('Sistema Ab Graduaciones en línea');
      });
    }
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en el puerto ${PORT}`);
});