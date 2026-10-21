require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const pagoController = require('../controllers/pagoController.js');

// Inicializar la aplicación Express
const app = express();

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
            success_url: 'http://127.0.0.1:5500/public/success.html',
            cancel_url: 'http://127.0.0.1:5500/public/cancel.html',
        });

        console.log('Sesión de Stripe creada con éxito. ID:', session.id);
        res.json({ id: session.id, url: session.url });
    } catch (error) {
        console.error('Error al procesar con Stripe:', error.message);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor ejecutándose en http://localhost:${PORT}`);
});