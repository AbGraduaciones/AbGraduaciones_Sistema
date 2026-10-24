require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const pagoController = require('../controllers/pagoController.js');

const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);

// Inicializar la aplicación Express
const app = express();

// Servir archivos estáticos de la carpeta public (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, '../public'))); // Soporte si public está en la raíz

// Verificar variables críticas en .env
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

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

app.use(cors());

// RUTA DEL WEBHOOK DE STRIPE (Debe ir ANTES de express.json())
app.post(
    '/webhook',
    express.raw({ type: 'application/json' }),
    pagoController.handleStripeWebhook
);

// Middleware para procesar JSON en el resto de la aplicación
app.use(express.json());

// RUTA RAÍZ GET /
app.get('/', (req, res) => {
    // Si tienes un index.html dentro de public, lo envía; de lo contrario, responde el estado de la API
    const indexPath = path.join(__dirname, 'public', 'index.html');
    res.sendFile(indexPath, (err) => {
        if (err) {
            res.json({
                status: 'online',
                mensaje: 'Sistema AbGraduaciones funcionando correctamente en Render'
            });
        }
    });
});

// ENDPOINT: Crear sesión de Checkout
app.post('/api/crear-checkout', async (req, res) => {
    console.log('---> Petición recibida en /api/crear-checkout');
    console.log('Datos recibidos (body):', req.body);

    try {
        const { nombreAlumno, concepto, monto, cuentaId, clienteId } = req.body;

        const montoNumerico = parseFloat(monto);
        if (!montoNumerico || isNaN(montoNumerico) || montoNumerico <= 0) {
            console.error('Monto inválido recibido:', monto);
            return res.status(400).json({ error: 'El monto especificado no es válido.' });
        }

        // Determinar URL base dinámica (producción en Render o local)
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
                        unit_amount: Math.round(montoNumerico * 100), // Convertir a centavos
                    },
                    quantity: 1,
                },
            ],
            mode: 'payment',
            metadata: {
                cuentaId: cuentaId || '',
                clienteId: clienteId || ''
            },
            success_url: `${baseUrl}/success.html`,
            cancel_url: `${baseUrl}/cancel.html`,
        });

        console.log('Sesión de Stripe creada con éxito. ID:', session.id);
        res.json({ id: session.id, url: session.url });
    } catch (error) {
        console.error('Error al procesar con Stripe:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Ruta para enviar código de acceso mediante Resend
app.post('/api/enviar-codigo-seguridad', async (req, res) => {
  const { email, nombre } = req.body;

  if (!email) {
    return res.status(400).json({ success: false, message: 'El correo es requerido' });
  }

  // Generar código aleatorio de 6 dígitos
  const codigoGenerado = Math.floor(100000 + Math.random() * 900000).toString();

  try {
    const data = await resend.emails.send({
      from: 'onboarding@resend.dev', // Correo de prueba de Resend (o tu dominio verificado)
      to: email,
      subject: 'Tu código de acceso - Ab Graduaciones',
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; color: #1e293b;">
          <h2>Hola, ${nombre || 'Alumno'}</h2>
          <p>Tu código de seguridad para ingresar a tu estado de cuenta es:</p>
          <h1 style="color: #2563eb; letter-spacing: 4px; font-size: 32px;">${codigoGenerado}</h1>
          <p>Este código es confidencial y de uso personal.</p>
          <br>
          <p>Atentamente,<br><strong>Ab Graduaciones</strong></p>
        </div>
      `
    });

    // Enviamos respuesta exitosa y el código para validar
    res.json({ success: true, codigo: codigoGenerado });
  } catch (error) {
    console.error('Error al enviar con Resend:', error);
    res.status(500).json({ success: false, message: 'No se pudo enviar el correo' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor ejecutándose en http://localhost:${PORT}`);
});// Memoria compartida en el servidor
let datosCompartidos = {
  alumnos: [],
  saldos: [],
  pagos: []
};

// 1. Ruta para que cualquier dispositivo consulte los datos actuales
app.get('/api/datos', (req, res) => {
  res.json(datosCompartidos);
});

// 2. Ruta para que cualquier dispositivo guarde o actualice los datos
app.post('/api/datos', (req, res) => {
  const { alumnos, saldos, pagos } = req.body;
  if (alumnos) datosCompartidos.alumnos = alumnos;
  if (saldos) datosCompartidos.saldos = saldos;
  if (pagos) datosCompartidos.pagos = pagos;
  res.json({ ok: true, mensaje: 'Datos sincronizados correctamente' });
});