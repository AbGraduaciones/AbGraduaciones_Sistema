require('dotenv').config();
const express = require('express'); 
const mongoose = require('mongoose');
const rutasClientes = require('./routes/clientes');

const app = express();
const PORT = process.env.PORT || 3000;

// Conexión a MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Conectado a la base de datos MongoDB'))
  .catch((error) => console.error('Error al conectar a MongoDB:', error));

app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Servidor corriendo correctamente' });
});

app.use('/api/clientes', rutasClientes);
app.use(express.static('public'));
app.listen(PORT, () => {
  console.log(`Servidor iniciado en http://localhost:${PORT}`);
});
app.use('/api/cuentas', require('./routes/cuentas'));
const pagoRoutes = require('./routes/pagoRoutes');

// ... después de las otras rutas
app.use('/api/pagos', pagoRoutes);
