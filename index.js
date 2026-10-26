require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

// Conexión a MongoDB
if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ Conectado a la base de datos MongoDB'))
    .catch((err) => console.error('❌ Error al conectar a MongoDB:', err.message));
}

// Memoria compartida accesible globalmente
global.datosCompartidos = {
  alumnos: [],
  saldos: [],
  pagos: []
};

// Carga tolerante del controlador de pagos
let pagoController;
const rutasPosibles = [
  './controllers/PagoController',
  './controllers/pagoController',
  '../controllers/PagoController',
  '../controllers/pagoController'
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

// Webhook de Stripe: DEBE ir antes de express.json()
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    if (pagoController && typeof pagoController.handleStripeWebhook === 'function') {
      return await pagoController.handleStripeWebhook(req, res);
    }
    res.status(200).json({ received: true });
  }
);

// Middlewares estándar
app.use(cors());
app.use(express.json());

// Servir frontend
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, '../public')));

// Rutas de sincronización para el frontend
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

// Crear sesión de Checkout Stripe
app.post('/api/crear-checkout', async (req, res) => {
  try {
    const { nombreAlumno, concepto, monto } = req.body;
    const cuentaId = req.body.cuentaId || req.body.cuenta_id || `CTA-${nombreAlumno || 'GENERAL'}`;
    const clienteId = req.body.clienteId || req.body.cliente_id || req.body.alumnoId || 'ALU-001';

    const montoNumerico = parseFloat(monto);
    if (!montoNumerico || isNaN(montoNumerico) || montoNumerico <= 0) {
      return res.status(400).json({ error: 'El monto especificado no es válido.' });
    }

    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: 'mxn',
            product_data: {
              name: 'Graduaciones - ' + (concepto || 'Pago'),
              description: 'Abono de ' + (nombreAlumno || 'Alumno'),
            },
            unit_amount: Math.round(montoNumerico * 100),
          },
          quantity: 1,
        },
      ],
      mode: 'payment',
      metadata: {
        cuentaId: String(cuentaId),
        clienteId: String(clienteId),
        alumnoId: String(clienteId),
        nombreAlumno: String(nombreAlumno || ''),
        concepto: String(concepto || 'Abono en Línea')
      },
      success_url: `${baseUrl}/?pago=exito`,
      cancel_url: `${baseUrl}/?pago=cancelado`,
    });

    res.json({ id: session.id, url: session.url });
  } catch (error) {
    console.error('❌ Error al crear checkout en Stripe:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Configuración de envío de correo
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

// Rutas API opcionales
try {
  app.use('/api/pagos', require('./routes/pagoRoutes'));
} catch (e) {}

// Ruta raíz
app.get('*', (req, res) => {
  const indexHtml = path.join(__dirname, 'public', 'index.html');
  res.sendFile(indexHtml, (err) => {
    if (err) res.send('Sistema Ab Graduaciones en línea');
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en el puerto ${PORT}`);
});