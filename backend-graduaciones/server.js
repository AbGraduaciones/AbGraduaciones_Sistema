require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const nodemailer = require('nodemailer');

// 1. Carga tolerante del controlador de pagos para evitar MODULE_NOT_FOUND en Render
let pagoController;
const rutasPosibles = [
  '../controllers/PagoController.js',
  '../controllers/pagoController.js',
  './controllers/PagoController.js',
  './controllers/pagoController.js',
  '../controllers/PagoController',
  '../controllers/pagoController'
];

for (const ruta of rutasPosibles) {
  try {
    pagoController = require(ruta);
    console.log(`✅ Controlador de pago cargado exitosamente desde: ${ruta}`);
    break;
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') {
      console.error(`⚠️ Error al cargar controlador desde ${ruta}:`, err.message);
    }
  }
}

// 2. Configuración del transportador de Gmail
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

// Memoria compartida en el servidor
let datosCompartidos = {
  alumnos: [],
  saldos: [],
  pagos: []
};

// Webhook de Stripe: procesa y registra automáticamente el abono en el historial
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    // Si existe el controlador externo y tiene su propio método, se delega; sino, se ejecuta el registro automático
    if (pagoController && typeof pagoController.handleStripeWebhook === 'function' && pagoController.handleStripeWebhook.length === 2) {
      try {
        return await pagoController.handleStripeWebhook(req, res);
      } catch (e) {
        console.warn('Controlador externo falló, ejecutando registrador interno:', e.message);
      }
    }

    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    let event;

    try {
      if (endpointSecret && process.env.STRIPE_SECRET_KEY) {
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
      const montoAbonado = session.amount_total ? session.amount_total / 100 : 0;
      const nombreAlumno = metadata.nombreAlumno || (session.customer_details && session.customer_details.name) || 'Alumno';
      const concepto = (session.line_items && session.line_items.data && session.line_items.data[0]?.description) || 'Abono en Línea (Stripe)';

      console.log(`💳 Pago completado en Stripe por $${montoAbonado} para: ${nombreAlumno}`);

      // Generar nuevo folio
      const nuevoFolioNum = datosCompartidos.pagos.length + 1;
      const folioId = 'PAG-' + String(nuevoFolioNum).padStart(3, '0');

      const nuevoPago = {
        id: folioId,
        alumno: nombreAlumno,
        concepto: concepto,
        monto: montoAbonado,
        fecha: new Date().toISOString().split('T')[0],
        metodo: 'Tarjeta (Stripe)',
        estado: 'Completado'
      };

      // Registrar en el historial de pagos
      datosCompartidos.pagos.unshift(nuevoPago);

      // Descontar del plan de abonos en la cuenta correspondiente
      const saldoEncontrado = datosCompartidos.saldos.find(s => 
        (s.id && s.id === metadata.cuentaId) ||
        (s._id && s._id === metadata.cuentaId) ||
        (s.alumno && s.alumno.toLowerCase() === nombreAlumno.toLowerCase())
      );

      if (saldoEncontrado) {
        if (!Array.isArray(saldoEncontrado.pagos)) {
          saldoEncontrado.pagos = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        }
        let asignado = false;
        for (let i = 0; i < 10; i++) {
          if (!saldoEncontrado.pagos[i] || saldoEncontrado.pagos[i] === 0) {
            saldoEncontrado.pagos[i] = montoAbonado;
            asignado = true;
            break;
          }
        }
        if (!asignado) {
          saldoEncontrado.pagos[9] = (parseFloat(saldoEncontrado.pagos[9]) || 0) + montoAbonado;
        }
        console.log(`✅ Abono aplicado a la cuenta de: ${saldoEncontrado.alumno}`);
      } else {
        console.warn(`⚠️ No se encontró la cuenta asociada al alumno "${nombreAlumno}" para aplicar el pago.`);
      }
    }

    res.status(200).json({ received: true });
  }
);

// Middleware para procesar JSON en el resto de las rutas
app.use(express.json());

// Servir archivos estáticos
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, '../public')));

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

// Checkout Stripe (Flexible y a prueba de errores 400)
app.post('/api/crear-checkout', async (req, res) => {
    try {
        console.log('📥 Petición recibida en /api/crear-checkout. Body:', req.body);

        const { nombreAlumno, concepto, monto } = req.body;

        const cuentaId = req.body.cuentaId || req.body.cuenta_id || req.body.idCuenta || req.body._id || req.body.alumnoId || `CTA-${nombreAlumno || 'GENERAL'}`;
        const clienteId = req.body.clienteId || req.body.cliente_id || req.body.idCliente || req.body.alumnoId || '';

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
                clienteId: String(clienteId),
                nombreAlumno: String(nombreAlumno || '')
            },
            success_url: `${baseUrl}/?pago=exito`,
            cancel_url: `${baseUrl}/?pago=cancelado`,
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

// Iniciar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor ejecutándose en http://localhost:${PORT}`);
});