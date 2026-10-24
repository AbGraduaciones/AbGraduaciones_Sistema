require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');
const pagoController = require('./controllers/pagoController.js');

// 1. Configuración robusta del transportador de Gmail
const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true, // SSL directo
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS // Contraseña de aplicación
  }
});

// Inicializar Express
const app = express();

// Diagnóstico de variables en consola
console.log('--- DIAGNÓSTICO DE INICIO ---');
if (!process.env.STRIPE_SECRET_KEY) {
    console.error('ERROR: No se encontró STRIPE_SECRET_KEY en el archivo .env');
} else {
    console.log('Clave Stripe cargada correctamente.');
}

if (!process.env.STRIPE_WEBHOOK_SECRET) {
    console.warn('AVISO: No se encontró STRIPE_WEBHOOK_SECRET en el archivo .env');
} else {
    console.log('Firma Webhook cargada correctamente.');
}

if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
    console.warn('AVISO: Faltan EMAIL_USER o EMAIL_PASS en el archivo .env');
} else {
    console.log(`Correo emisor configurado: ${process.env.EMAIL_USER}`);
}

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

app.use(cors());

// Webhook de Stripe (debe ir ANTES de express.json() y usar raw body)
app.post(
    '/webhook',
    express.raw({ type: 'application/json' }),
    pagoController.handleStripeWebhook
);

// Middleware para procesar JSON en el resto de las rutas
app.use(express.json());

// Servir archivos estáticos
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, '../public')));

// Memoria compartida en el servidor
let datosCompartidos = {
  alumnos: [],
  saldos: [],
  pagos: []
};

// Rutas de sincronización
app.get('/api/datos', (req, res) => {
  res.json(datosCompartidos);
});

app.post('/api/datos', (req, res) => {
  const { alumnos, saldos, pagos } = req.body;
  if (alumnos) datosCompartidos.alumnos = alumnos;
  if (saldos) datosCompartidos.saldos = saldos;
  if (pagos) datosCompartidos.pagos = pagos;
  res.json({ ok: true, mensaje: 'Datos sincronizados correctamente' });
});

// Ruta raíz
app.get('/', (req, res) => {
    const indexPath = path.join(__dirname, 'public', 'index.html');
    res.sendFile(indexPath, (err) => {
        if (err) {
            res.json({
                status: 'online',
                mensaje: 'Sistema AbGraduaciones funcionando correctamente'
            });
        }
    });
});

// Checkout Stripe
app.post('/api/crear-checkout', async (req, res) => {
    try {
        console.log('📥 Petición recibida en /api/crear-checkout. Body:', req.body);

        const { nombreAlumno, concepto, monto } = req.body;

        // Soporta diferentes nomenclaturas comunes para el ID de la cuenta
        const cuentaId = req.body.cuentaId || req.body.cuenta_id || req.body.idCuenta || req.body._id;
        const clienteId = req.body.clienteId || req.body.cliente_id || req.body.idCliente || '';

        // Validar que se reciba el identificador de la cuenta
        if (!cuentaId) {
            console.error('❌ Error: Falta cuentaId en el cuerpo de la petición.');
            return res.status(400).json({ 
                error: 'Falta el identificador de la cuenta (cuentaId). El pago no puede asociarse.' 
            });
        }

        const montoNumerico = parseFloat(monto);
        if (!montoNumerico || isNaN(montoNumerico) || montoNumerico <= 0) {
            return res.status(400).json({ error: 'El monto especificado no es válido.' });
        }

        const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;

        console.log(`🚀 Creando sesión de Stripe con cuentaId: ${cuentaId}, Monto: $${montoNumerico}`);

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
                clienteId: String(clienteId)
            },
            success_url: `${baseUrl}/success.html`,
            cancel_url: `${baseUrl}/cancel.html`,
        });

        res.json({ id: session.id, url: session.url });
    } catch (error) {
        console.error('❌ Error al procesar con Stripe:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Envío de código de seguridad
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
          <p style="font-size: 12px; color: #64748b;">Si no solicitaste este código, puedes ignorar este mensaje.</p>
        </div>
      `
    });

    console.log(`Código enviado exitosamente a ${email}`);
    res.json({ success: true, codigo, message: 'Código enviado exitosamente' });
  } catch (error) {
    console.error('Error detallado al enviar correo:', error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// Iniciar servidor al final
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor ejecutándose en http://localhost:${PORT}`);
});