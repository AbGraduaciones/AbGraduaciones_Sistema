require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');

// Carga segura de bcryptjs
let bcrypt;
try {
  bcrypt = require('bcryptjs');
} catch (e) {
  console.warn('⚠️ Advertencia al cargar bcryptjs:', e.message);
}

const app = express();
const PORT = process.env.PORT || 3000;

// Almacén temporal en memoria para códigos OTP de acceso
const codigosOtpTemporales = new Map();

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

// Modelo Grupo
const GrupoSchema = new mongoose.Schema({
  nombre: { type: String, required: true, trim: true },
  institucion: { type: String, trim: true, default: '' },
  carrera: { type: String, trim: true, default: '' },
  preciosPaquetes: { type: mongoose.Schema.Types.Mixed, default: {} },
  activo: { type: Boolean, default: true }
}, { timestamps: true });

const Grupo = cargarModelo(['./models/Grupo', './models/grupo']) || mongoose.model('Grupo', GrupoSchema);

const Cliente = cargarModelo(['./models/Cliente', './models/cliente', './models/Clientes', './models/clientes']) || mongoose.model('Cliente', new mongoose.Schema({
  id: String,
  nombre: String,
  email: { type: String, default: '' },
  telefono: String,
  universidad: String,
  facultad: String,
  escuela: String,
  grupoId: { type: mongoose.Schema.Types.Mixed, default: null },
  grupoNombre: { type: String, default: '' }
}, { strict: false, timestamps: true }));

const Cuenta = cargarModelo(['./models/Cuenta', './models/cuenta', './models/Cuentas', './models/cuentas']) || mongoose.model('Cuenta', new mongoose.Schema({
  id: String,
  cliente: mongoose.Schema.Types.Mixed,
  alumno: String,
  paquete: String,
  monto: Number,
  saldo: Number,
  pagos: [Number],
  entregas: mongoose.Schema.Types.Mixed,
  eleccionEspecial: String,
  esContadoEfectivo: Boolean,
  pagada: Boolean,
  grupoId: { type: mongoose.Schema.Types.Mixed, default: null },
  grupoNombre: { type: String, default: '' }
}, { strict: false, timestamps: true }));

const Pago = cargarModelo(['./models/Pago', './models/pago', './models/Pagos', './models/pagos']) || mongoose.model('Pago', new mongoose.Schema({
  id: String,
  cuenta: mongoose.Schema.Types.Mixed,
  cliente: mongoose.Schema.Types.Mixed,
  alumno: String,
  concepto: String,
  monto: Number,
  fecha: Date,
  metodoPago: String,
  grupoId: { type: mongoose.Schema.Types.Mixed, default: null },
  notas: String
}, { strict: false, timestamps: true }));

const Usuario = cargarModelo(['./models/Usuario', './models/usuario', './models/Usuarios', './models/usuarios']) || mongoose.model('Usuario', new mongoose.Schema({
  nombre: { type: String, required: true, trim: true },
  usuario: { type: String, required: true, unique: true, trim: true, lowercase: true },
  email: { type: String, required: true, unique: true, trim: true, lowercase: true },
  telefono: { type: String, trim: true },
  password: { type: String, required: true },
  rol: { type: String, enum: ['admin', 'staff'], default: 'staff' },
  activo: { type: Boolean, default: true }
}, { timestamps: true }));

// Middleware de autenticación (Asigna nombre Harold al administrador principal)
const requireAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Panel de Administrador"');
    return res.status(401).send('Acceso denegado: se requieren credenciales');
  }

  const authData = Buffer.from(authHeader.split(' ')[1], 'base64').toString().split(':');
  const usuario = authData[0];
  const password = authData.slice(1).join(':');

  const adminUser = process.env.ADMIN_USER || 'admin';
  const adminPass = process.env.ADMIN_PASS;

  if (usuario === adminUser && password === adminPass) {
    req.usuarioSesion = { usuario: adminUser, rol: 'admin', nombre: 'Harold' };
    return next();
  }

  try {
    if (mongoose.connection.readyState !== 1) {
      await new Promise((resolve) => {
        if (mongoose.connection.readyState === 1) return resolve();
        mongoose.connection.once('connected', resolve);
        setTimeout(resolve, 3000);
      });
    }

    if (Usuario && bcrypt) {
      const usuarioBD = await Usuario.findOne({ 
        usuario: (usuario || '').trim().toLowerCase(), 
        activo: true 
      }).lean();

      if (usuarioBD && usuarioBD.password) {
        const passwordCorrecta = await bcrypt.compare(password, usuarioBD.password);
        if (passwordCorrecta) {
          req.usuarioSesion = {
            id: usuarioBD._id,
            usuario: usuarioBD.usuario,
            nombre: usuarioBD.nombre,
            rol: usuarioBD.rol || 'staff'
          };
          return next();
        }
      }
    }
  } catch (errAuth) {
    console.error('Error al validar credenciales en base de datos:', errAuth.message);
  }

  res.setHeader('WWW-Authenticate', 'Basic realm="Panel de Administrador"');
  return res.status(401).send('Acceso denegado: usuario o contraseña incorrectos');
};

const requireAdmin = (req, res, next) => {
  if (req.usuarioSesion && req.usuarioSesion.rol === 'admin') {
    return next();
  }
  return res.status(403).json({ ok: false, error: 'Acceso no autorizado: requiere permisos de Administrador' });
};

// Memoria compartida accesible globalmente
global.datosCompartidos = {
  alumnos: [],
  saldos: [],
  pagos: [],
  grupos: []
};

// Saneamiento de pagos anónimos en base de datos
async function sanearPagosAnonimosEnBD() {
  if (mongoose.connection.readyState !== 1) return;
  try {
    const pagosAnonimos = await Pago.find({
      $or: [
        { alumno: 'Alumno' },
        { alumno: '' },
        { alumno: null }
      ]
    });

    if (pagosAnonimos.length === 0) return;

    for (const p of pagosAnonimos) {
      let nombreReal = '';

      if (p.notas && p.notas.includes('Alumno:')) {
        const match = p.notas.match(/Alumno:\s*([^|]+)/i);
        if (match && match[1] && match[1].trim().toLowerCase() !== 'alumno') {
          nombreReal = match[1].trim();
        }
      }

      if (!nombreReal && stripe && p.id && String(p.id).startsWith('cs_')) {
        try {
          const ses = await stripe.checkout.sessions.retrieve(p.id);
          if (ses) {
            const meta = ses.metadata || {};
            const nomMeta = (meta.nombreAlumno || meta.alumno || '').trim();
            if (nomMeta && nomMeta.toLowerCase() !== 'alumno') {
              nombreReal = nomMeta;
            } else if (ses.customer_details && ses.customer_details.name && ses.customer_details.name.toLowerCase() !== 'alumno') {
              nombreReal = ses.customer_details.name.trim();
            }
          }
        } catch (eStripe) {}
      }

      if (!nombreReal && p.cuenta) {
        const cta = await Cuenta.findOne({
          $or: [
            ...(mongoose.Types.ObjectId.isValid(p.cuenta) ? [{ _id: new mongoose.Types.ObjectId(p.cuenta) }] : []),
            { id: String(p.cuenta) }
          ]
        }).lean();
        if (cta && cta.alumno && cta.alumno.toLowerCase() !== 'alumno') {
          nombreReal = cta.alumno.trim();
        }
      }

      if (!nombreReal && p.cliente) {
        const cli = await Cliente.findOne({
          $or: [
            ...(mongoose.Types.ObjectId.isValid(p.cliente) ? [{ _id: new mongoose.Types.ObjectId(p.cliente) }] : []),
            { id: String(p.cliente) }
          ]
        }).lean();
        if (cli && cli.nombre && cli.nombre.toLowerCase() !== 'alumno') {
          nombreReal = cli.nombre.trim();
        }
      }

      if (!nombreReal && p.monto) {
        const ctaMonto = await Cuenta.findOne({ pagos: Number(p.monto) }).lean();
        if (ctaMonto && ctaMonto.alumno && ctaMonto.alumno.toLowerCase() !== 'alumno') {
          nombreReal = ctaMonto.alumno.trim();
        }
      }

      if (nombreReal) {
        p.alumno = nombreReal;
        await p.save();
      }
    }
  } catch (errSanear) {
    console.warn('⚠️ Aviso en saneamiento de pagos:', errSanear.message);
  }
}

// Sincronización desde MongoDB Atlas hacia la Memoria Global
async function sincronizarMemoriaDesdeBD() {
  if (mongoose.connection.readyState !== 1) return;
  try {
    await sanearPagosAnonimosEnBD();

    const clientesBD = await Cliente.find().lean();
    const cuentasBD = await Cuenta.find().lean();
    const pagosBD = await Pago.find().sort({ fecha: -1, createdAt: -1 }).lean();
    const gruposBD = await Grupo.find({ activo: true }).sort({ createdAt: 1 }).lean();

    global.datosCompartidos.grupos = gruposBD.map(g => ({
      _id: String(g._id),
      id: String(g._id),
      nombre: g.nombre,
      institucion: g.institucion || '',
      carrera: g.carrera || '',
      preciosPaquetes: g.preciosPaquetes || {}
    }));

    global.datosCompartidos.alumnos = clientesBD.map(c => ({
      _id: String(c._id),
      id: c.id ? String(c.id) : String(c._id),
      nombre: (c.nombre || '').trim(),
      email: c.email || '',
      telefono: c.telefono || '',
      universidad: c.universidad || '',
      facultad: c.facultad || '',
      escuela: c.facultad || c.universidad || c.escuela || '',
      grupoId: c.grupoId ? String(c.grupoId) : null,
      grupoNombre: c.grupoNombre || ''
    }));

    global.datosCompartidos.saldos = cuentasBD.map(cta => {
      const montoTotal = Number(cta.monto) || 0;
      const pagosArr = Array.isArray(cta.pagos) && cta.pagos.length === 10 ? cta.pagos : [0,0,0,0,0,0,0,0,0,0];
      const pagado = pagosArr.reduce((acc, val) => acc + (Number(val) || 0), 0);
      const saldoFinal = Math.max(0, montoTotal - pagado);

      return {
        id: cta.id || String(cta._id),
        _id: String(cta._id),
        cliente: cta.cliente ? String(cta.cliente) : '',
        alumno: (cta.alumno || '').trim(),
        paquete: cta.paquete,
        monto: montoTotal,
        saldo: saldoFinal,
        saldoPendiente: saldoFinal,
        pagos: pagosArr,
        entregas: cta.entregas || {},
        eleccionEspecial: cta.eleccionEspecial || '',
        esContadoEfectivo: Boolean(cta.esContadoEfectivo),
        grupoId: cta.grupoId ? String(cta.grupoId) : null,
        grupoNombre: cta.grupoNombre || ''
      };
    });

    global.datosCompartidos.pagos = pagosBD.map((p, idx) => {
      let nom = (p.alumno || '').trim();
      if (!nom || nom.toLowerCase() === 'alumno') {
        if (p.cuenta) {
          const cta = cuentasBD.find(c => String(c._id) === String(p.cuenta) || String(c.id) === String(p.cuenta));
          if (cta && cta.alumno && cta.alumno.toLowerCase() !== 'alumno') nom = cta.alumno.trim();
        }
        if ((!nom || nom.toLowerCase() === 'alumno') && p.cliente) {
          const cli = clientesBD.find(c => String(c.id) === String(p.cliente) || String(c._id) === String(p.cliente));
          if (cli && cli.nombre && cli.nombre.toLowerCase() !== 'alumno') nom = cli.nombre.trim();
        }
      }
      if (!nom) nom = 'Alumno';

      return {
        _id: String(p._id),
        id: p.id || String(p._id) || `PAG-${String(idx + 1).padStart(3, '0')}`,
        folio: p.id || String(p._id) || `PAG-${String(idx + 1).padStart(3, '0')}`,
        cuentaId: p.cuenta ? String(p.cuenta) : '',
        alumnoId: p.cliente ? String(p.cliente) : '',
        alumno: nom,
        nombreAlumno: nom,
        concepto: p.concepto || 'Abono de Graduación',
        monto: Number(p.monto) || 0,
        montoAbonado: Number(p.monto) || 0,
        fecha: p.fecha ? new Date(p.fecha).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
        metodo: p.metodoPago === 'stripe' ? 'Tarjeta (Stripe)' : (p.metodoPago || p.metodo || 'Efectivo'),
        estado: 'Completado',
        grupoId: p.grupoId ? String(p.grupoId) : null,
        notas: p.notas || ''
      };
    });
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
    break;
  } catch (err) {
    if (err.code !== 'MODULE_NOT_FOUND') {
      console.error(`⚠️ Error al cargar controlador desde ${ruta}:`, err.message);
    }
  }
}

const stripe = process.env.STRIPE_SECRET_KEY ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;

// 3. Webhook de Stripe
app.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  if (pagoController && typeof pagoController.handleStripeWebhook === 'function') {
    try {
      const resultado = await pagoController.handleStripeWebhook(req, res);
      await sincronizarMemoriaDesdeBD();
      return resultado;
    } catch (err) {
      console.error('Error delegando webhook:', err.message);
    }
  }
  return res.status(200).json({ received: true });
});

// 4. Middlewares
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// 5. Rutas de sincronización general
app.get('/api/datos', async (req, res) => {
  if (mongoose.connection.readyState === 1) {
    await sincronizarMemoriaDesdeBD();
  }
  res.json(global.datosCompartidos);
});

app.post('/api/datos', async (req, res) => {
  try {
    const { alumnos, saldos, grupos } = req.body;

    if (Array.isArray(grupos)) {
      global.datosCompartidos.grupos = grupos;
    }

    if (Array.isArray(alumnos)) {
      if (mongoose.connection.readyState === 1) {
        for (const a of alumnos) {
          if (!a || !a.id) continue;
          await Cliente.findOneAndUpdate(
            { id: String(a.id) },
            {
              id: String(a.id),
              nombre: (a.nombre || '').trim(),
              email: a.email || '',
              telefono: a.telefono,
              universidad: a.universidad,
              facultad: a.facultad || a.escuela,
              escuela: a.escuela || a.facultad,
              grupoId: a.grupoId || null,
              grupoNombre: a.grupoNombre || ''
            },
            { upsert: true, new: true }
          );
        }
      } else {
        global.datosCompartidos.alumnos = alumnos;
      }
    }

    if (Array.isArray(saldos)) {
      if (mongoose.connection.readyState === 1) {
        for (const s of saldos) {
          if (!s) continue;
          const cuentaExistente = await Cuenta.findOne({
            $or: [
              ...(s._id && mongoose.Types.ObjectId.isValid(s._id) ? [{ _id: new mongoose.Types.ObjectId(s._id) }] : []),
              { id: s.id },
              { alumno: new RegExp(`^${(s.alumno || '').trim()}$`, 'i') }
            ]
          }).lean();

          let pagosArr = Array.isArray(s.pagos) ? [...s.pagos] : [0,0,0,0,0,0,0,0,0,0];
          const montoTotal = Number(s.monto) || (cuentaExistente ? cuentaExistente.monto : 0);
          const pagado = pagosArr.reduce((acc, val) => acc + (Number(val) || 0), 0);
          const saldoFinal = Math.max(0, montoTotal - pagado);

          const filtroCuenta = cuentaExistente 
            ? { _id: cuentaExistente._id } 
            : { $or: [{ id: s.id }, { alumno: (s.alumno || '').trim() }] };

          await Cuenta.findOneAndUpdate(
            filtroCuenta,
            {
              id: s.id || (cuentaExistente ? cuentaExistente.id : 'CTA-' + Date.now()),
              cliente: s.cliente || (cuentaExistente ? cuentaExistente.cliente : '1001'),
              alumno: (s.alumno || '').trim(),
              paquete: s.paquete,
              monto: montoTotal,
              saldo: saldoFinal,
              pagos: pagosArr,
              entregas: s.entregas || {},
              eleccionEspecial: s.eleccionEspecial || (cuentaExistente ? cuentaExistente.eleccionEspecial : ''),
              esContadoEfectivo: Boolean(s.esContadoEfectivo),
              pagada: saldoFinal <= 0,
              grupoId: s.grupoId || (cuentaExistente ? cuentaExistente.grupoId : null),
              grupoNombre: s.grupoNombre || (cuentaExistente ? cuentaExistente.grupoNombre : '')
            },
            { upsert: true, new: true }
          );
        }
      } else {
        global.datosCompartidos.saldos = saldos;
      }
    }

    if (mongoose.connection.readyState === 1) {
      await sincronizarMemoriaDesdeBD();
    }

    res.json({ ok: true, mensaje: 'Datos sincronizados correctamente' });
  } catch (error) {
    console.error('Error al persistir en /api/datos:', error.message);
    res.json({ ok: true, mensaje: 'Guardado en memoria de respaldo' });
  }
});

app.delete('/api/historial-pagos-alumno/:nombreAlumno', async (req, res) => {
  try {
    const nombre = decodeURIComponent(req.params.nombreAlumno || '').trim();
    if (!nombre) {
      return res.status(400).json({ ok: false, error: 'Nombre de alumno no especificado' });
    }

    const reg = new RegExp(`^${nombre}$`, 'i');

    if (mongoose.connection.readyState === 1) {
      await Pago.deleteMany({ alumno: reg });

      const cta = await Cuenta.findOne({ alumno: reg });
      if (cta) {
        cta.pagos = [0,0,0,0,0,0,0,0,0,0];
        cta.saldo = Number(cta.monto) || 0;
        cta.pagada = false;
        await cta.save();
      }
      await sincronizarMemoriaDesdeBD();
    } else {
      global.datosCompartidos.pagos = global.datosCompartidos.pagos.filter(p => !reg.test((p.alumno || '').trim()));
      const s = global.datosCompartidos.saldos.find(s => reg.test((s.alumno || '').trim()));
      if (s) {
        s.pagos = [0,0,0,0,0,0,0,0,0,0];
        s.saldo = Number(s.monto) || 0;
        s.saldoPendiente = s.saldo;
      }
    }

    res.json({ ok: true, mensaje: `Historial de pagos de "${nombre}" eliminado permanentemente.` });
  } catch (err) {
    console.error('Error al borrar historial de alumno:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/historial-pagos-vaciar-todo', requireAuth, async (req, res) => {
  try {
    if (mongoose.connection.readyState === 1) {
      await Pago.deleteMany({});
      await Cuenta.updateMany({}, {
        $set: {
          pagos: [0,0,0,0,0,0,0,0,0,0],
          pagada: false
        }
      });
      const cuentas = await Cuenta.find({});
      for (const c of cuentas) {
        c.saldo = Number(c.monto) || 0;
        await c.save();
      }
      await sincronizarMemoriaDesdeBD();
    }
    global.datosCompartidos.pagos = [];
    global.datosCompartidos.saldos.forEach(s => {
      s.pagos = [0,0,0,0,0,0,0,0,0,0];
      s.saldo = Number(s.monto) || 0;
      s.saldoPendiente = s.saldo;
    });
    res.json({ ok: true, mensaje: 'Historial de pagos vaciado por completo' });
  } catch (err) {
    console.error('Error vaciando historial de pagos:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/saldos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (mongoose.connection.readyState === 1) {
      const orFiltro = [{ id: id }];
      if (mongoose.Types.ObjectId.isValid(id)) {
        orFiltro.push({ _id: new mongoose.Types.ObjectId(id) });
      }
      await Cuenta.deleteMany({ $or: orFiltro });
      await sincronizarMemoriaDesdeBD();
    } else {
      global.datosCompartidos.saldos = global.datosCompartidos.saldos.filter(s => String(s.id || s._id) !== String(id));
    }
    res.json({ ok: true, mensaje: 'Saldo eliminado permanentemente' });
  } catch (err) {
    console.error('Error eliminando saldo:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/alumnos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (mongoose.connection.readyState === 1) {
      const orFiltro = [{ id: String(id) }];
      if (mongoose.Types.ObjectId.isValid(id)) {
        orFiltro.push({ _id: new mongoose.Types.ObjectId(id) });
      }
      await Cliente.deleteMany({ $or: orFiltro });
      await sincronizarMemoriaDesdeBD();
    } else {
      global.datosCompartidos.alumnos = global.datosCompartidos.alumnos.filter(a => String(a.id || a._id) !== String(id));
    }
    res.json({ ok: true, mensaje: 'Alumno eliminado permanentemente' });
  } catch (err) {
    console.error('Error eliminando alumno:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/historial-pagos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    if (mongoose.connection.readyState === 1) {
      const orFiltro = [{ id: id }];
      if (mongoose.Types.ObjectId.isValid(id)) {
        orFiltro.push({ _id: new mongoose.Types.ObjectId(id) });
      }

      const pagoABorrar = await Pago.findOne({ $or: orFiltro }).lean();
      await Pago.deleteMany({ $or: orFiltro });

      if (pagoABorrar && pagoABorrar.alumno) {
        const pagosRestantes = await Pago.find({ 
          alumno: new RegExp(`^${pagoABorrar.alumno.trim()}$`, 'i') 
        }).sort({ fecha: 1 }).lean();

        const nuevosAbonos = [0,0,0,0,0,0,0,0,0,0];
        pagosRestantes.slice(0, 10).forEach((p, i) => {
          nuevosAbonos[i] = Number(p.monto) || 0;
        });

        const totalPagado = nuevosAbonos.reduce((a, b) => a + b, 0);
        const cuentaObj = await Cuenta.findOne({ alumno: new RegExp(`^${pagoABorrar.alumno.trim()}$`, 'i') });
        if (cuentaObj) {
          const montoTotal = Number(cuentaObj.monto) || 0;
          const saldoFinal = Math.max(0, montoTotal - totalPagado);
          cuentaObj.pagos = nuevosAbonos;
          cuentaObj.saldo = saldoFinal;
          cuentaObj.pagada = saldoFinal <= 0;
          await cuentaObj.save();
        }
      }

      await sincronizarMemoriaDesdeBD();
    } else {
      global.datosCompartidos.pagos = global.datosCompartidos.pagos.filter(p => String(p.id || p._id) !== String(id));
    }
    res.json({ ok: true, mensaje: 'Pago eliminado permanentemente' });
  } catch (err) {
    console.error('Error eliminando pago:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/api/historial-pagos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { alumno, concepto, monto, fecha, metodo } = req.body;

    if (mongoose.connection.readyState === 1) {
      const orFiltro = [{ id: id }];
      if (mongoose.Types.ObjectId.isValid(id)) {
        orFiltro.push({ _id: new mongoose.Types.ObjectId(id) });
      }

      await Pago.updateMany(
        { $or: orFiltro },
        {
          alumno: (alumno || '').trim(),
          concepto,
          monto: Number(monto) || 0,
          fecha: fecha ? new Date(fecha) : new Date(),
          metodoPago: metodo
        }
      );

      const pagosRestantes = await Pago.find({ 
        alumno: new RegExp(`^${(alumno || '').trim()}$`, 'i') 
      }).sort({ fecha: 1 }).lean();

      const nuevosAbonos = [0,0,0,0,0,0,0,0,0,0];
      pagosRestantes.slice(0, 10).forEach((p, i) => {
        nuevosAbonos[i] = Number(p.monto) || 0;
      });

      const totalPagado = nuevosAbonos.reduce((a, b) => a + b, 0);
      const cuentaObj = await Cuenta.findOne({ alumno: new RegExp(`^${(alumno || '').trim()}$`, 'i') });
      if (cuentaObj) {
        const montoTotal = Number(cuentaObj.monto) || 0;
        const saldoFinal = Math.max(0, montoTotal - totalPagado);
        cuentaObj.pagos = nuevosAbonos;
        cuentaObj.saldo = saldoFinal;
        cuentaObj.pagada = saldoFinal <= 0;
        await cuentaObj.save();
      }

      await sincronizarMemoriaDesdeBD();
    } else {
      const idx = global.datosCompartidos.pagos.findIndex(p => String(p.id || p._id) === String(id));
      if (idx !== -1) {
        global.datosCompartidos.pagos[idx] = {
          ...global.datosCompartidos.pagos[idx],
          alumno: (alumno || '').trim(),
          concepto,
          monto: Number(monto) || 0,
          fecha,
          metodo
        };
      }
    }
    res.json({ ok: true, mensaje: 'Pago actualizado permanentemente' });
  } catch (err) {
    console.error('Error actualizando pago:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const procesarCheckout = (req, res) => {
  if (pagoController && typeof pagoController.crearCheckoutSession === 'function') {
    return pagoController.crearCheckoutSession(req, res);
  }
  return res.status(500).json({ status: 'error', message: 'Controlador de pagos no disponible' });
};

app.post('/api/crear-checkout', procesarCheckout);
app.post('/api/pagos/crear-checkout-session', procesarCheckout);

// Verificación sesión Stripe
app.get('/api/verificar-sesion-stripe/:sessionId', async (req, res) => {
  try {
    const { sessionId } = req.params;
    if (!sessionId || !sessionId.startsWith('cs_')) {
      return res.status(400).json({ ok: false, error: 'Session ID no válido' });
    }

    if (!stripe) {
      return res.status(500).json({ ok: false, error: 'Stripe no está configurado' });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!session || session.payment_status !== 'paid') {
      return res.status(400).json({ ok: false, error: 'El pago aún no figura como liquidado en Stripe' });
    }

    const metadata = session.metadata || {};
    let nombreAlumno = (metadata.nombreAlumno || metadata.alumno || '').trim();
    const cuentaId = metadata.cuentaId || metadata.cuenta_id || '';
    const alumnoId = metadata.alumnoId || metadata.clienteId || '';
    const concepto = metadata.concepto || 'Abono en Línea (Stripe)';
    const monto = metadata.montoNetoAbono 
      ? parseFloat(metadata.montoNetoAbono) 
      : (session.amount_total ? session.amount_total / 100 : 0);

    if (!nombreAlumno || nombreAlumno.toLowerCase() === 'alumno') {
      if (session.customer_details && session.customer_details.name && session.customer_details.name.toLowerCase() !== 'alumno') {
        nombreAlumno = session.customer_details.name.trim();
      }
    }

    if (!nombreAlumno || nombreAlumno.toLowerCase() === 'alumno') {
      if (mongoose.connection.readyState === 1) {
        if (cuentaId) {
          const cta = await Cuenta.findOne({
            $or: [
              ...(mongoose.Types.ObjectId.isValid(cuentaId) ? [{ _id: new mongoose.Types.ObjectId(cuentaId) }] : []),
              { id: String(cuentaId) }
            ]
          }).lean();
          if (cta && cta.alumno && cta.alumno.toLowerCase() !== 'alumno') {
            nombreAlumno = cta.alumno.trim();
          }
        }
        if ((!nombreAlumno || nombreAlumno.toLowerCase() === 'alumno') && alumnoId) {
          const cli = await Cliente.findOne({
            $or: [
              ...(mongoose.Types.ObjectId.isValid(alumnoId) ? [{ _id: new mongoose.Types.ObjectId(alumnoId) }] : []),
              { id: String(alumnoId) }
            ]
          }).lean();
          if (cli && cli.nombre && cli.nombre.toLowerCase() !== 'alumno') {
            nombreAlumno = cli.nombre.trim();
          }
        }
      }
    }

    if (pagoController && typeof pagoController.aplicarAbonoACuenta === 'function') {
      await pagoController.aplicarAbonoACuenta({
        cuentaId,
        alumnoId,
        nombreAlumno: nombreAlumno || 'Alumno',
        monto,
        concepto,
        sessionId: session.id,
        customerEmail: session.customer_email || metadata.email || ''
      });
    }

    if (mongoose.connection.readyState === 1) {
      await sincronizarMemoriaDesdeBD();
    }

    res.json({ ok: true, mensaje: 'Pago verificado y saldo aplicado' });
  } catch (error) {
    console.error('Error al verificar sesión directa:', error.message);
    res.status(500).json({ ok: false, error: error.message });
  }
});

let transporter = null;
if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
  transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
}

app.post('/api/enviar-codigo-seguridad', async (req, res) => {
  try {
    const { email, nombre, alumnoId, codigo: codigoRecibido } = req.body;
    const codigo = codigoRecibido || Math.floor(100000 + Math.random() * 900000).toString();
    const expiracion = Date.now() + 15 * 60 * 1000;

    if (alumnoId) codigosOtpTemporales.set(String(alumnoId).toLowerCase(), { codigo: String(codigo), expira: expiracion });
    if (email) codigosOtpTemporales.set(String(email).toLowerCase(), { codigo: String(codigo), expira: expiracion });

    if (transporter && email) {
      try {
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
              <p style="font-size: 12px; color: #64748b;">Este código es válido por 15 minutos.</p>
            </div>
          `
        });
      } catch (errCorreo) {
        console.warn('⚠️ No se pudo enviar el correo:', errCorreo.message);
      }
    }

    return res.json({ success: true, codigo, message: 'Código procesado exitosamente' });
  } catch (error) {
    console.error('Error al procesar código de seguridad:', error.message);
    res.status(200).json({ success: true, message: 'Código generado en modo de contingencia' });
  }
});

app.post('/api/verificar-codigo-seguridad', (req, res) => {
  const { alumnoId, email, codigo } = req.body;
  const codigoStr = String(codigo || '').trim();

  const claveAlumno = alumnoId ? String(alumnoId).toLowerCase() : null;
  const claveEmail = email ? String(email).toLowerCase() : null;

  const otpData = (claveAlumno && codigosOtpTemporales.get(claveAlumno)) ||
                  (claveEmail && codigosOtpTemporales.get(claveEmail));

  if (otpData) {
    if (Date.now() > otpData.expira) {
      codigosOtpTemporales.delete(claveAlumno);
      codigosOtpTemporales.delete(claveEmail);
      return res.status(400).json({ success: false, message: 'El código ha expirado. Solicita uno nuevo.' });
    }

    if (otpData.codigo === codigoStr) {
      codigosOtpTemporales.delete(claveAlumno);
      codigosOtpTemporales.delete(claveEmail);
      return res.json({ success: true, message: 'Código verificado con éxito' });
    }
  }

  return res.status(400).json({ success: false, message: 'Código incorrecto o no encontrado' });
});

// Perfil que devuelve Harold para el admin master
app.get('/api/mi-perfil', requireAuth, (req, res) => {
  const esMaster = (req.usuarioSesion?.usuario === (process.env.ADMIN_USER || 'admin'));
  res.json({
    ok: true,
    usuario: req.usuarioSesion?.usuario,
    nombre: esMaster ? 'Harold' : (req.usuarioSesion?.nombre || 'Harold'),
    rol: req.usuarioSesion?.rol || 'staff'
  });
});

app.get('/api/grupos', requireAuth, async (req, res) => {
  try {
    if (mongoose.connection.readyState === 1) {
      const grupos = await Grupo.find({ activo: true }).sort({ createdAt: 1 }).lean();
      res.json({ ok: true, grupos });
    } else {
      res.json({ ok: true, grupos: global.datosCompartidos.grupos || [] });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/grupos', requireAuth, async (req, res) => {
  try {
    const { nombre, institucion, carrera, preciosPaquetes } = req.body;
    if (!nombre || !nombre.trim()) {
      return res.status(400).json({ ok: false, error: 'El nombre del grupo es obligatorio.' });
    }

    if (mongoose.connection.readyState === 1) {
      const nuevoGrupo = new Grupo({
        nombre: nombre.trim(),
        institucion: institucion ? institucion.trim() : '',
        carrera: carrera ? carrera.trim() : '',
        preciosPaquetes: preciosPaquetes || {}
      });
      await nuevoGrupo.save();
      await sincronizarMemoriaDesdeBD();
      res.json({ ok: true, grupo: nuevoGrupo });
    } else {
      const gLocal = {
        _id: 'GRP-' + Date.now(),
        id: 'GRP-' + Date.now(),
        nombre: nombre.trim(),
        institucion: institucion || '',
        carrera: carrera || '',
        preciosPaquetes: preciosPaquetes || {}
      };
      global.datosCompartidos.grupos.push(gLocal);
      res.json({ ok: true, grupo: gLocal });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.put('/api/grupos/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, institucion, carrera, preciosPaquetes } = req.body;

    if (mongoose.connection.readyState === 1 && mongoose.Types.ObjectId.isValid(id)) {
      const g = await Grupo.findById(id);
      if (!g) return res.status(404).json({ ok: false, error: 'Grupo no encontrado' });

      if (nombre) g.nombre = nombre.trim();
      if (institucion !== undefined) g.institucion = institucion.trim();
      if (carrera !== undefined) g.carrera = carrera.trim();
      if (preciosPaquetes) g.preciosPaquetes = preciosPaquetes;

      await g.save();
      await sincronizarMemoriaDesdeBD();
      res.json({ ok: true, grupo: g });
    } else {
      const idx = global.datosCompartidos.grupos.findIndex(gr => String(gr._id || gr.id) === String(id));
      if (idx !== -1) {
        if (nombre) global.datosCompartidos.grupos[idx].nombre = nombre.trim();
        if (institucion !== undefined) global.datosCompartidos.grupos[idx].institucion = institucion;
        if (carrera !== undefined) global.datosCompartidos.grupos[idx].carrera = carrera;
        if (preciosPaquetes) global.datosCompartidos.grupos[idx].preciosPaquetes = preciosPaquetes;
      }
      res.json({ ok: true, grupo: global.datosCompartidos.grupos[idx] });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/grupos/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (mongoose.connection.readyState === 1 && mongoose.Types.ObjectId.isValid(id)) {
      await Grupo.findByIdAndUpdate(id, { activo: false });
      await sincronizarMemoriaDesdeBD();
    } else {
      global.datosCompartidos.grupos = global.datosCompartidos.grupos.filter(g => String(g._id || g.id) !== String(id));
    }
    res.json({ ok: true, mensaje: 'Grupo eliminado' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/usuarios', requireAuth, requireAdmin, async (req, res) => {
  try {
    const usuarios = await Usuario.find({}, '-password').sort({ createdAt: -1 }).lean();
    res.json({ ok: true, usuarios, rolActual: 'admin' });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error al obtener usuarios' });
  }
});

app.put('/api/usuarios/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { nombre, usuario, email, telefono, rol, activo, password } = req.body;

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ ok: false, error: 'ID de usuario no válido' });
    }

    const usuarioExistente = await Usuario.findById(id);
    if (!usuarioExistente) {
      return res.status(404).json({ ok: false, error: 'Usuario no encontrado' });
    }

    if (usuario && usuario.trim().toLowerCase() !== usuarioExistente.usuario) {
      const repetido = await Usuario.findOne({ 
        usuario: usuario.trim().toLowerCase(), 
        _id: { $ne: id } 
      });
      if (repetido) {
        return res.status(400).json({ ok: false, error: `El nombre de usuario "${usuario}" ya está en uso.` });
      }
      usuarioExistente.usuario = usuario.trim().toLowerCase();
    }

    if (email && email.trim().toLowerCase() !== usuarioExistente.email) {
      const repetidoEmail = await Usuario.findOne({ 
        email: email.trim().toLowerCase(), 
        _id: { $ne: id } 
      });
      if (repetidoEmail) {
        return res.status(400).json({ ok: false, error: `El correo "${email}" ya está en uso.` });
      }
      usuarioExistente.email = email.trim().toLowerCase();
    }

    if (nombre) usuarioExistente.nombre = nombre.trim();
    if (telefono !== undefined) usuarioExistente.telefono = telefono.trim();
    if (rol && ['admin', 'staff'].includes(rol)) usuarioExistente.rol = rol;
    if (activo !== undefined) usuarioExistente.activo = Boolean(activo);

    if (password && String(password).trim().length > 0) {
      if (!bcrypt) {
        return res.status(500).json({ ok: false, error: 'Módulo bcryptjs no disponible para encriptar.' });
      }
      const salt = await bcrypt.genSalt(10);
      usuarioExistente.password = await bcrypt.hash(String(password).trim(), salt);
    }

    await usuarioExistente.save();

    res.json({
      ok: true,
      mensaje: 'Usuario actualizado correctamente',
      usuario: {
        _id: usuarioExistente._id,
        nombre: usuarioExistente.nombre,
        usuario: usuarioExistente.usuario,
        email: usuarioExistente.email,
        telefono: usuarioExistente.telefono,
        rol: usuarioExistente.rol,
        activo: usuarioExistente.activo
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Error al actualizar usuario' });
  }
});

app.get('/logo.png', (req, res) => {
  const posiblesRutasLogo = [
    path.join(process.cwd(), 'public', 'logo.png'),
    path.join(__dirname, 'public', 'logo.png'),
    path.join(__dirname, '..', 'public', 'logo.png'),
    path.join(__dirname, 'logo.png')
  ];

  for (const ruta of posiblesRutasLogo) {
    if (fs.existsSync(ruta)) {
      return res.sendFile(ruta);
    }
  }
  res.status(404).send('Logo no encontrado');
});

app.use(express.static(path.join(process.cwd(), 'public'), { index: false }));
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

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

// =========================================================================
// RUTA DE CIERRE DE SESIÓN DEFINITIVO (BASIC AUTH):
// Destruye la caché de credenciales en el navegador con encabezados 401 y Clear-Site-Data
// =========================================================================
app.get('/api/logout', (req, res) => {
  res.setHeader('Clear-Site-Data', '"cache", "cookies", "storage"');
  res.setHeader('WWW-Authenticate', 'Basic realm="Panel de Administrador", charset="UTF-8"');
  res.status(401).send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8">
      <title>Sesión Cerrada</title>
      <script>
        try { sessionStorage.clear(); } catch(e){}
        window.location.replace('/pago');
      </script>
    </head>
    <body style="background:#0f172a; color:#fff; font-family:sans-serif; text-align:center; padding-top:60px;">
      <h2>🔒 Sesión cerrada correctamente</h2>
      <p>Credenciales invalidadas. Redirigiendo...</p>
    </body>
    </html>
  `);
});

app.get(['/', '/pago', '/portal'], (req, res) => {
  entregarIndex(res);
});

app.get(['/admin', '/admn'], requireAuth, (req, res) => {
  entregarIndex(res);
});

app.use((req, res) => {
  res.redirect('/pago');
});

const servidor = app.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en el puerto ${PORT}`);
});

module.exports = { app, servidor };