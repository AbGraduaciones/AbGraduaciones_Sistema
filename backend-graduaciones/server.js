require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

let bcrypt;
try {
  bcrypt = require('bcryptjs');
} catch (e) {
  console.warn('⚠️ Advertencia al cargar bcryptjs:', e.message);
}

const app = express();
const PORT = process.env.PORT || 3000;

const mpClient = process.env.MERCADOPAGO_ACCESS_TOKEN
  ? new MercadoPagoConfig({ accessToken: process.env.MERCADOPAGO_ACCESS_TOKEN })
  : null;

const codigosOtpTemporales = new Map();

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
  observaciones: { type: String, default: '' },
  monto: Number,
  saldo: Number,
  pagos: [Number],
  entregas: mongoose.Schema.Types.Mixed,
  eleccionEspecial: String,
  cargoExtraRegalia: { type: Number, default: 0 },
  tipoPanoramica: { type: String, default: '' },
  tallaCamisa: { type: String, default: '' },
  tallaAnillo: { type: String, default: '' },
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

const Egreso = cargarModelo(['./models/Egreso', './models/egreso']) || mongoose.model('Egreso', new mongoose.Schema({
  concepto: { type: String, required: true, trim: true },
  monto: { type: Number, required: true },
  categoria: { type: String, default: 'Operativo' },
  fecha: { type: Date, default: Date.now },
  grupoId: { type: mongoose.Schema.Types.Mixed, default: null },
  grupoNombre: { type: String, default: '' },
  notas: { type: String, default: '' }
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

// ==========================================
// MODELOS: INVENTARIO, PROVEEDORES Y COMPRAS
// ==========================================

const ProveedorSchema = new mongoose.Schema({
  nombre: { type: String, required: true, trim: true },
  categoria: {
    type: String,
    enum: ['marcos', 'anillos', 'playeras', 'personalizadores', 'otros'],
    default: 'marcos'
  },
  telefono: { type: String, trim: true, default: '' },
  diasProduccionDefault: { type: Number, default: 15 },
  notas: { type: String, default: '' },
  activo: { type: Boolean, default: true }
}, { timestamps: true });

const Proveedor = cargarModelo(['./models/Proveedor', './models/proveedor']) || mongoose.model('Proveedor', ProveedorSchema);

const EquivalenciaProveedorSchema = new mongoose.Schema({
  proveedorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Proveedor', required: true },
  nombreProveedor: { type: String, required: true, trim: true },
  colorProveedor: { type: String, default: '', trim: true },
  costoUnitario: { type: Number, required: true, min: 0 },
  diasProduccion: { type: Number, default: 15 }
}, { _id: false });

const CatalogoInsumoSchema = new mongoose.Schema({
  categoria: {
    type: String,
    enum: ['marco', 'diploma', 'anillo', 'playera', 'personalizador', 'otro'],
    required: true
  },
  linea: { type: String, default: '', trim: true },
  modeloInterno: { type: String, required: true, trim: true },
  colorInterno: { type: String, default: '', trim: true },
  tamanoOTalla: { type: String, required: true, trim: true },
  stockDisponible: { type: Number, default: 0, min: 0 },
  equivalencias: [EquivalenciaProveedorSchema],
  activo: { type: Boolean, default: true }
}, { timestamps: true });

CatalogoInsumoSchema.index({ categoria: 1, modeloInterno: 1, tamanoOTalla: 1 });

const CatalogoInsumo = cargarModelo(['./models/CatalogoInsumo', './models/catalogoInsumo']) || mongoose.model('CatalogoInsumo', CatalogoInsumoSchema);

const ItemOrdenSchema = new mongoose.Schema({
  insumoId: { type: mongoose.Schema.Types.ObjectId, ref: 'CatalogoInsumo', default: null },
  categoria: { type: String, default: 'marco' },
  nombreInterno: { type: String, required: true },
  nombreProveedor: { type: String, required: true },
  colorProveedor: { type: String, default: '' },
  tamanoOTalla: { type: String, required: true },
  cantidadRequerida: { type: Number, required: true, min: 1 },
  stockUsado: { type: Number, default: 0, min: 0 },
  cantidadPedida: { type: Number, required: true, min: 1 },
  cantidadRecibida: { type: Number, default: 0, min: 0 },
  costoUnitario: { type: Number, required: true, min: 0 },
  subtotal: { type: Number, required: true, min: 0 }
});

const PagoProveedorSchema = new mongoose.Schema({
  fecha: { type: Date, default: Date.now },
  monto: { type: Number, required: true, min: 0.01 },
  metodo: { type: String, enum: ['transferencia', 'efectivo', 'deposito', 'tarjeta'], default: 'transferencia' },
  referencia: { type: String, default: '' },
  nota: { type: String, default: '' }
});

const OrdenCompraSchema = new mongoose.Schema({
  folio: { type: String, unique: true },
  proveedorId: { type: mongoose.Schema.Types.ObjectId, ref: 'Proveedor', required: true },
  gruposIncluidos: [{ type: String }],
  estatus: {
    type: String,
    enum: ['borrador', 'enviado', 'en_produccion', 'en_camino', 'recibido_parcial', 'recibido', 'cancelado'],
    default: 'borrador'
  },
  fechaPedido: { type: Date, default: Date.now },
  fechaPromesaEntrega: { type: Date },
  fechaGraduacionMasProxima: { type: Date },
  items: [ItemOrdenSchema],
  totalOrden: { type: Number, default: 0 },
  pagos: [PagoProveedorSchema],
  totalPagado: { type: Number, default: 0 },
  saldoPendiente: { type: Number, default: 0 },
  notas: { type: String, default: '' }
}, { timestamps: true });

OrdenCompraSchema.pre('save', function (next) {
  this.items.forEach(item => {
    item.subtotal = Number((Number(item.cantidadPedida || 0) * Number(item.costoUnitario || 0)).toFixed(2));
  });
  this.totalOrden = Number(this.items.reduce((acc, it) => acc + (Number(it.subtotal) || 0), 0).toFixed(2));
  this.totalPagado = Number(this.pagos.reduce((acc, p) => acc + (Number(p.monto) || 0), 0).toFixed(2));
  this.saldoPendiente = Number(Math.max(0, this.totalOrden - this.totalPagado).toFixed(2));
  next();
});

const OrdenCompra = cargarModelo(['./models/OrdenCompra', './models/ordenCompra']) || mongoose.model('OrdenCompra', OrdenCompraSchema);

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

global.datosCompartidos = {
  alumnos: [],
  saldos: [],
  pagos: [],
  grupos: [],
  egresos: []
};

function normalizarNombreServidor(txt) {
  return String(txt || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

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

async function sincronizarMemoriaDesdeBD() {
  if (mongoose.connection.readyState !== 1) return;
  try {
    await sanearPagosAnonimosEnBD();

    const clientesBD = await Cliente.find().lean();
    const cuentasBD = await Cuenta.find().lean();
    const pagosBD = await Pago.find().sort({ fecha: -1, createdAt: -1 }).lean();
    const gruposBD = await Grupo.find({ activo: true }).sort({ createdAt: 1 }).lean();
    const egresosBD = await Egreso.find().sort({ fecha: -1, createdAt: -1 }).lean();

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
        observaciones: cta.observaciones || '',
        monto: montoTotal,
        saldo: saldoFinal,
        saldoPendiente: saldoFinal,
        pagos: pagosArr,
        entregas: cta.entregas || {},
        eleccionEspecial: cta.eleccionEspecial || '',
        cargoExtraRegalia: Number(cta.cargoExtraRegalia) || 0,
        tipoPanoramica: cta.tipoPanoramica || '',
        tallaCamisa: cta.tallaCamisa || '',
        tallaAnillo: cta.tallaAnillo || '',
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
        metodo: p.metodoPago || p.metodo || 'Efectivo',
        estado: 'Completado',
        grupoId: p.grupoId ? String(p.grupoId) : null,
        notas: p.notas || ''
      };
    });

    global.datosCompartidos.egresos = egresosBD.map(e => ({
      _id: String(e._id),
      id: String(e._id),
      concepto: e.concepto || '',
      monto: Number(e.monto) || 0,
      categoria: e.categoria || 'Operativo',
      fecha: e.fecha ? new Date(e.fecha).toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
      grupoId: e.grupoId ? String(e.grupoId) : null,
      grupoNombre: e.grupoNombre || '',
      notas: e.notas || ''
    }));
  } catch (err) {
    console.error('⚠️ Error al sincronizar desde MongoDB:', err.message);
  }
}

const mongoUri = process.env.MONGODB_URI || process.env.MONGOOSE_URI;
if (mongoUri) {
  mongoose.connect(mongoUri, { serverSelectionTimeoutMS: 5000 })
    .then(async () => {
      console.log('✅ Conectado exitosamente a MongoDB Atlas');
      await sincronizarMemoriaDesdeBD();
    })
    .catch((err) => console.error('❌ Error de conexión a MongoDB:', err.message));
}

app.use(cors());
app.use(express.json({ limit: '10mb' }));

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
      const nombresVistos = new Set();
      for (const s of saldos) {
        if (!s || !s.alumno) continue;
        const norm = normalizarNombreServidor(s.alumno);
        if (nombresVistos.has(norm)) {
          return res.status(400).json({
            ok: false,
            error: `El alumno "${s.alumno.trim()}" ya tiene un saldo registrado. Edita su cuenta existente en lugar de duplicarla.`
          });
        }
        nombresVistos.add(norm);
      }

      if (mongoose.connection.readyState === 1) {
        const todasCuentasBD = await Cuenta.find({}).lean();

        for (const s of saldos) {
          if (!s) continue;
          const normAlumno = normalizarNombreServidor(s.alumno);
          const cuentaExistente = todasCuentasBD.find(c =>
            (s._id && String(c._id) === String(s._id)) ||
            (s.id && String(c.id) === String(s.id)) ||
            normalizarNombreServidor(c.alumno) === normAlumno
          );

          let pagosArr = Array.isArray(s.pagos) ? [...s.pagos] : [0,0,0,0,0,0,0,0,0,0];
          const montoTotal = Number(s.monto) || (cuentaExistente ? cuentaExistente.monto : 0);
          const pagado = pagosArr.reduce((acc, val) => acc + (Number(val) || 0), 0);
          const saldoFinal = Math.max(0, montoTotal - pagado);

          const filtroCuenta = cuentaExistente 
            ? { _id: cuentaExistente._id } 
            : { $or: [{ id: s.id }, { alumno: (s.alumno || '').trim() }] };

          const cuentaGuardada = await Cuenta.findOneAndUpdate(
            filtroCuenta,
            {
              id: s.id || (cuentaExistente ? cuentaExistente.id : 'CTA-' + Date.now()),
              cliente: s.cliente || (cuentaExistente ? cuentaExistente.cliente : '1001'),
              alumno: (s.alumno || '').trim(),
              paquete: s.paquete,
              observaciones: s.observaciones !== undefined ? s.observaciones : (cuentaExistente ? cuentaExistente.observaciones : ''),
              monto: montoTotal,
              saldo: saldoFinal,
              pagos: pagosArr,
              entregas: s.entregas || {},
              eleccionEspecial: s.eleccionEspecial !== undefined ? s.eleccionEspecial : (cuentaExistente ? cuentaExistente.eleccionEspecial : ''),
              cargoExtraRegalia: s.cargoExtraRegalia !== undefined ? Number(s.cargoExtraRegalia) : (cuentaExistente ? Number(cuentaExistente.cargoExtraRegalia || 0) : 0),
              tipoPanoramica: s.tipoPanoramica !== undefined ? s.tipoPanoramica : (cuentaExistente ? cuentaExistente.tipoPanoramica : ''),
              tallaCamisa: s.tallaCamisa !== undefined ? s.tallaCamisa : (cuentaExistente ? cuentaExistente.tallaCamisa : ''),
              tallaAnillo: s.tallaAnillo !== undefined ? s.tallaAnillo : (cuentaExistente ? cuentaExistente.tallaAnillo : ''),
              esContadoEfectivo: Boolean(s.esContadoEfectivo),
              pagada: saldoFinal <= 0,
              grupoId: s.grupoId || (cuentaExistente ? cuentaExistente.grupoId : null),
              grupoNombre: s.grupoNombre || (cuentaExistente ? cuentaExistente.grupoNombre : '')
            },
            { upsert: true, new: true }
          );

          const nombreAlumnoLimpio = (s.alumno || '').trim();
          if (nombreAlumnoLimpio && nombreAlumnoLimpio.toLowerCase() !== 'alumno') {
            for (let i = 0; i < 10; i++) {
              const montoCasilla = Number(pagosArr[i]) || 0;
              const conceptoCasilla = s.esContadoEfectivo ? 'Pago Contado Efectivo' : `Pago ${i + 1}`;
              const identificadorPagoManual = `PAG-${cuentaGuardada._id || cuentaGuardada.id}-C${i + 1}`;

              if (montoCasilla > 0) {
                await Pago.findOneAndUpdate(
                  { 
                    $or: [
                      { id: identificadorPagoManual },
                      { cuenta: cuentaGuardada._id, concepto: conceptoCasilla }
                    ]
                  },
                  {
                    $set: {
                      id: identificadorPagoManual,
                      cuenta: cuentaGuardada._id,
                      cliente: cuentaGuardada.cliente || '1001',
                      alumno: nombreAlumnoLimpio,
                      concepto: conceptoCasilla,
                      monto: montoCasilla,
                      metodoPago: s.esContadoEfectivo ? 'Efectivo (Contado)' : 'Efectivo / Transferencia (Admin)',
                      grupoId: cuentaGuardada.grupoId || null,
                      notas: `Abono registrado por Administrador | Alumno: ${nombreAlumnoLimpio}`
                    },
                    $setOnInsert: {
                      fecha: new Date()
                    }
                  },
                  { upsert: true, new: true }
                );
              } else {
                await Pago.deleteMany({
                  id: identificadorPagoManual
                });
              }
            }
          }
        }
      } else {
        global.datosCompartidos.saldos = saldos;
      }
    }

    res.json({ ok: true, mensaje: 'Datos sincronizados correctamente' });
  } catch (error) {
    console.error('Error al persistir en /api/datos:', error.message);
    res.json({ ok: true, mensaje: 'Guardado en memoria de respaldo' });
  }
});

app.get('/api/egresos', requireAuth, async (req, res) => {
  try {
    if (mongoose.connection.readyState === 1) {
      const egresos = await Egreso.find().sort({ fecha: -1, createdAt: -1 }).lean();
      res.json({ ok: true, egresos });
    } else {
      res.json({ ok: true, egresos: global.datosCompartidos.egresos || [] });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/egresos', requireAuth, async (req, res) => {
  try {
    const { concepto, monto, categoria, fecha, grupoId, grupoNombre, notas } = req.body;
    if (!concepto || !monto) {
      return res.status(400).json({ ok: false, error: 'Concepto y monto son obligatorios.' });
    }

    if (mongoose.connection.readyState === 1) {
      const nuevoEgreso = new Egreso({
        concepto: concepto.trim(),
        monto: Number(monto) || 0,
        categoria: categoria || 'Operativo',
        fecha: fecha ? new Date(fecha) : new Date(),
        grupoId: grupoId || null,
        grupoNombre: grupoNombre || '',
        notas: notas || ''
      });
      await nuevoEgreso.save();
      await sincronizarMemoriaDesdeBD();
      res.json({ ok: true, egreso: nuevoEgreso });
    } else {
      const egLocal = {
        _id: 'EGR-' + Date.now(),
        id: 'EGR-' + Date.now(),
        concepto: concepto.trim(),
        monto: Number(monto) || 0,
        categoria: categoria || 'Operativo',
        fecha: fecha || new Date().toISOString().split('T')[0],
        grupoId: grupoId || null,
        grupoNombre: grupoNombre || '',
        notas: notas || ''
      };
      global.datosCompartidos.egresos.push(egLocal);
      res.json({ ok: true, egreso: egLocal });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete('/api/egresos/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    if (mongoose.connection.readyState === 1 && mongoose.Types.ObjectId.isValid(id)) {
      await Egreso.findByIdAndDelete(id);
      await sincronizarMemoriaDesdeBD();
    } else {
      global.datosCompartidos.egresos = global.datosCompartidos.egresos.filter(e => String(e._id || e.id) !== String(id));
    }
    res.json({ ok: true, mensaje: 'Egreso eliminado' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
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

function generarReciboPDFBuffer({ folio, fecha, alumno, universidad, carrera, paquete, observaciones, montoAbonado, nuevoSaldo, tipoPanoramica, tallaCamisa, tallaAnillo, eleccionEspecial, cargoExtraRegalia }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    const buffers = [];

    doc.on('data', buffers.push.bind(buffers));
    doc.on('end', () => resolve(Buffer.concat(buffers)));
    doc.on('error', reject);

    doc.fillColor('#1e3a8a').fontSize(20).text('AB GRADUACIONES', { align: 'left' });
    doc.fillColor('#3b82f6').fontSize(10).text('Comprobante Oficial de Pago Digital', { align: 'left' });
    doc.moveDown();

    doc.fillColor('#0f172a').fontSize(11);
    doc.text(`Folio: ${folio}`);
    doc.text(`Fecha: ${fecha}`);
    doc.moveDown();

    doc.rect(40, doc.y, 515, 75).fillAndStroke('#f0f9ff', '#bae6fd');
    doc.fillColor('#0369a1').fontSize(9).text('DATOS DEL ALUMNO Y PAQUETE', 50, doc.y + 10);
    doc.fillColor('#0f172a').fontSize(12).text(`Alumno: ${alumno}`, 50);
    doc.fontSize(10).text(`Carrera / Institución: ${carrera} - ${universidad}`, 50);
    doc.text(`Paquete: ${paquete}`, 50);
    doc.moveDown(2);

    if (observaciones && observaciones.trim() !== '') {
      doc.fillColor('#0369a1').fontSize(10).text('MODIFICACIONES / OBSERVACIONES:');
      doc.fillColor('#334155').fontSize(10).text(observaciones.trim());
      doc.moveDown();
    }

    doc.fillColor('#15803d').fontSize(12).text(`Monto Abonado: $${Number(montoAbonado).toLocaleString()} MXN`);
    doc.fillColor('#b45309').fontSize(12).text(`Saldo Pendiente Restante: $${Number(nuevoSaldo).toLocaleString()} MXN`);
    doc.moveDown();

    const esBasic = String(paquete || '').toLowerCase().includes('línea basic') || String(paquete || '').toLowerCase().includes('linea basic');

    if (!esBasic && (tipoPanoramica || tallaCamisa || tallaAnillo || eleccionEspecial)) {
      doc.fillColor('#1e3a8a').fontSize(11).text('ESPECIFICACIONES DE ENTREGA Y REGALÍA:');
      doc.fillColor('#334155').fontSize(10);
      if (tipoPanoramica) doc.text(`• Panorámica con marco: ${tipoPanoramica}`);
      if (tallaCamisa) doc.text(`• Camisa personalizada: Talla ${tallaCamisa}`);
      if (eleccionEspecial === 'Sin regalía') {
        doc.text(`• Regalía Especial: El alumno optó por no recibir regalía`);
      } else if (eleccionEspecial === 'Ambos (Anillo + Personalizador)') {
        const extraAnillo = tallaAnillo ? ` - Número ${tallaAnillo}` : '';
        const extraMonto = Number(cargoExtraRegalia) > 0 ? ` (+$${Number(cargoExtraRegalia).toLocaleString()} MXN adicionales incluidos)` : '';
        doc.text(`• Regalía Especial: Ambas regalías incluidas (Anillo de Plata 925${extraAnillo} y Personalizador)${extraMonto}`);
      } else if (eleccionEspecial) {
        const extraAnillo = (eleccionEspecial === 'Anillo de Plata 925' && tallaAnillo) ? ` (Número ${tallaAnillo})` : '';
        doc.text(`• Regalía Especial: ${eleccionEspecial}${extraAnillo}`);
      } else if (tallaAnillo) {
        doc.text(`• Talla Anillo: Número ${tallaAnillo}`);
      }
      doc.moveDown();
    } else if (esBasic && tipoPanoramica) {
      doc.fillColor('#1e3a8a').fontSize(11).text('ESPECIFICACIONES DE ENTREGA:');
      doc.fillColor('#334155').fontSize(10);
      doc.text(`• Panorámica con marco: ${tipoPanoramica}`);
      doc.moveDown();
    }

    doc.fillColor('#64748b').fontSize(9).text('Gracias por tu pago. Conserva este comprobante oficial para cualquier aclaración.', { align: 'center' });

    doc.end();
  });
}

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

async function enviarReciboPorCorreo(destinatarioEmail, datosPago) {
  if (!transporter || !destinatarioEmail) return;

  try {
    const pdfBuffer = await generarReciboPDFBuffer(datosPago);

    await transporter.sendMail({
      from: `"Ab Graduaciones" <${process.env.EMAIL_USER}>`,
      to: destinatarioEmail,
      subject: `Comprobante de Pago - Folio ${datosPago.folio}`,
      html: `
        <div style="font-family: Arial, sans-serif; color: #1e293b; padding: 20px;">
          <h2 style="color: #1e3a8a;">¡Hola, ${datosPago.alumno}!</h2>
          <p>Tu abono de <strong>$${Number(datosPago.montoAbonado).toLocaleString()} MXN</strong> ha sido procesado con éxito.</p>
          <p>Tu nuevo saldo pendiente es de: <strong>$${Number(datosPago.nuevoSaldo).toLocaleString()} MXN</strong>.</p>
          <p>Adjunto encontrarás tu comprobante oficial en formato PDF.</p>
          <br>
          <p style="font-size: 12px; color: #64748b;">Ab Graduaciones - Sistema Integral</p>
        </div>
      `,
      attachments: [
        {
          filename: `Recibo_${datosPago.folio}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf'
        }
      ]
    });

    console.log(`✉️ Recibo PDF enviado exitosamente a: ${destinatarioEmail}`);
  } catch (error) {
    console.error('❌ Error enviando recibo PDF por correo:', error.message);
  }
}

// ==========================================
// INTEGRACIÓN MERCADO PAGO (CHECKOUT PRO)
// ==========================================

async function aplicarPagoMercadoPago(paymentInfo) {
  if (!paymentInfo || paymentInfo.status !== 'approved') return { aplicado: false };
  if (mongoose.connection.readyState !== 1) return { aplicado: false };

  const folioMP = `MP-${paymentInfo.id}`;
  const yaExiste = await Pago.findOne({ id: folioMP }).lean();
  if (yaExiste) {
    return { aplicado: true, duplicado: true };
  }

  const meta = paymentInfo.metadata || {};
  const cuentaId = meta.cuenta_id || '';
  const alumnoId = meta.alumno_id || '';
  let nombreAlumno = (meta.nombre_alumno || '').trim();
  const concepto = meta.concepto || 'Abono en Línea (Mercado Pago)';
  const monto = Number(meta.monto_neto || paymentInfo.transaction_amount) || 0;
  const emailMeta = meta.email || (paymentInfo.payer && paymentInfo.payer.email) || '';

  let cuentaObj = null;
  if (cuentaId) {
    const filtro = [{ id: String(cuentaId) }];
    if (mongoose.Types.ObjectId.isValid(cuentaId)) {
      filtro.push({ _id: new mongoose.Types.ObjectId(cuentaId) });
    }
    cuentaObj = await Cuenta.findOne({ $or: filtro });
  }
  if (!cuentaObj && nombreAlumno) {
    cuentaObj = await Cuenta.findOne({ alumno: new RegExp(`^${nombreAlumno}$`, 'i') });
  }

  if (cuentaObj) {
    if (!nombreAlumno || nombreAlumno.toLowerCase() === 'alumno') {
      nombreAlumno = (cuentaObj.alumno || 'Alumno').trim();
    }
    const pagosArr = Array.isArray(cuentaObj.pagos) && cuentaObj.pagos.length === 10
      ? [...cuentaObj.pagos]
      : [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    const matchNum = String(concepto).match(/Pago\s*(\d+)/i);
    let idxCasilla = -1;
    if (matchNum && matchNum[1]) {
      const n = parseInt(matchNum[1], 10) - 1;
      if (n >= 0 && n < 10 && Number(pagosArr[n]) === 0) idxCasilla = n;
    }
    if (idxCasilla === -1) {
      idxCasilla = pagosArr.findIndex(v => Number(v) === 0);
    }
    if (idxCasilla !== -1) {
      pagosArr[idxCasilla] = monto;
    } else {
      pagosArr[9] = (Number(pagosArr[9]) || 0) + monto;
    }

    const totalPagado = pagosArr.reduce((acc, v) => acc + (Number(v) || 0), 0);
    const saldoFinal = Math.max(0, (Number(cuentaObj.monto) || 0) - totalPagado);

    cuentaObj.pagos = pagosArr;
    cuentaObj.saldo = saldoFinal;
    cuentaObj.pagada = saldoFinal <= 0;
    await cuentaObj.save();
  }

  const tipoMP = String(paymentInfo.payment_type_id || '').toLowerCase();
  const metodoIdMP = String(paymentInfo.payment_method_id || '').toLowerCase();
  let metodoExactoMP = 'Mercado Pago';

  if (tipoMP.includes('card')) {
    metodoExactoMP = 'Mercado Pago - Tarjeta';
  } else if (tipoMP === 'bank_transfer' || metodoIdMP.includes('spei') || metodoIdMP.includes('clabe')) {
    metodoExactoMP = 'Mercado Pago - SPEI';
  } else if (tipoMP === 'ticket' || tipoMP === 'atm' || metodoIdMP.includes('oxxo')) {
    metodoExactoMP = 'Mercado Pago - OXXO';
  } else if (tipoMP === 'account_money') {
    metodoExactoMP = 'Mercado Pago - Saldo MP';
  }

  await Pago.create({
    id: folioMP,
    cuenta: cuentaObj ? cuentaObj._id : cuentaId,
    cliente: cuentaObj ? cuentaObj.cliente : alumnoId,
    alumno: nombreAlumno || 'Alumno',
    concepto,
    monto,
    fecha: new Date(),
    metodoPago: metodoExactoMP,
    grupoId: cuentaObj ? cuentaObj.grupoId : null,
    notas: `Pago aprobado en Mercado Pago (#${paymentInfo.id}) | Alumno: ${nombreAlumno || 'Alumno'}`
  });

  if (emailMeta) {
    const cliDatos = await Cliente.findOne({
      nombre: new RegExp(`^${nombreAlumno}$`, 'i')
    }).lean();

    await enviarReciboPorCorreo(emailMeta, {
      folio: folioMP,
      fecha: new Date().toISOString().split('T')[0],
      alumno: nombreAlumno || 'Alumno',
      universidad: cliDatos?.universidad || 'Universidad',
      carrera: cliDatos?.escuela || cliDatos?.facultad || 'Carrera',
      paquete: cuentaObj?.paquete || 'Graduación',
      observaciones: cuentaObj?.observaciones || '',
      montoAbonado: monto,
      nuevoSaldo: cuentaObj?.saldo ?? 0,
      tipoPanoramica: cuentaObj?.tipoPanoramica || '',
      tallaCamisa: cuentaObj?.tallaCamisa || '',
      tallaAnillo: cuentaObj?.tallaAnillo || '',
      eleccionEspecial: cuentaObj?.eleccionEspecial || '',
      cargoExtraRegalia: Number(cuentaObj?.cargoExtraRegalia) || 0
    });
  }

  await sincronizarMemoriaDesdeBD();
  return { aplicado: true };
}

const crearPreferenciaMP = async (req, res) => {
  try {
    if (!mpClient) {
      return res.status(500).json({ ok: false, error: 'Mercado Pago no está configurado (falta MERCADOPAGO_ACCESS_TOKEN).' });
    }

    const { cuentaId, alumnoId, clienteId, nombreAlumno, alumno, email, concepto, monto } = req.body;
    const montoNeto = parseFloat(monto) || 0;
    if (montoNeto <= 0) {
      return res.status(400).json({ ok: false, error: 'El monto a pagar debe ser mayor a 0.' });
    }

    // Suma comisión de Mercado Pago (3.49% + $4.00 MXN + 16% IVA) para recibir el monto neto íntegro
    const montoConComision = Number(((montoNeto + 4.64) / 0.959516).toFixed(2));

    const nombreFinal = (nombreAlumno || alumno || 'Alumno').trim();
    const conceptoFinal = concepto || 'Abono de Graduación';
    const baseUrl = (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

    const preference = new Preference(mpClient);
    const body = {
      items: [
        {
          id: String(cuentaId || alumnoId || 'ABONO'),
          title: `${conceptoFinal} - ${nombreFinal} (Incluye comisión por pago en línea)`,
          quantity: 1,
          unit_price: montoConComision,
          currency_id: 'MXN'
        }
      ],
      metadata: {
        cuenta_id: String(cuentaId || ''),
        alumno_id: String(alumnoId || clienteId || ''),
        nombre_alumno: nombreFinal,
        concepto: conceptoFinal,
        monto_neto: montoNeto,
        email: String(email || '')
      },
      back_urls: {
        success: `${baseUrl}/pago?pago=exito`,
        failure: `${baseUrl}/pago?pago=cancelado`,
        pending: `${baseUrl}/pago?pago=pendiente`
      },
      auto_return: 'approved',
      notification_url: `${baseUrl}/api/webhook-mercadopago`
    };

    if (email && email.includes('@')) {
      body.payer = { email: email.trim() };
    }

    const result = await preference.create({ body });
    const urlPago = result.init_point || result.sandbox_init_point;

    if (!urlPago) {
      return res.status(500).json({ ok: false, error: 'Mercado Pago no devolvió un enlace de pago.' });
    }

    res.json({ ok: true, url: urlPago, id: result.id });
  } catch (error) {
    console.error('❌ Error creando preferencia de Mercado Pago:', error.message);
    res.status(500).json({ ok: false, error: error.message || 'Error al conectar con Mercado Pago' });
  }
};

app.post('/api/crear-checkout-mp', crearPreferenciaMP);
app.post('/api/pagos/crear-checkout-session', crearPreferenciaMP);
app.post('/api/crear-checkout', crearPreferenciaMP);

app.post('/api/webhook-mercadopago', async (req, res) => {
  try {
    const tipo = req.body?.type || req.query?.topic || req.query?.type;
    const paymentId = req.body?.data?.id || req.query?.['data.id'] || req.query?.id;

    if (mpClient && (tipo === 'payment' || req.body?.action?.startsWith('payment')) && paymentId) {
      const payment = new Payment(mpClient);
      const paymentInfo = await payment.get({ id: paymentId });
      if (paymentInfo && paymentInfo.status === 'approved') {
        await aplicarPagoMercadoPago(paymentInfo);
      }
    }
    res.status(200).json({ received: true });
  } catch (err) {
    console.error('❌ Error en webhook de Mercado Pago:', err.message);
    res.status(200).json({ received: true });
  }
});

app.get('/api/verificar-pago-mp/:paymentId', async (req, res) => {
  try {
    const { paymentId } = req.params;
    if (!mpClient) {
      return res.status(500).json({ ok: false, error: 'Mercado Pago no está configurado' });
    }
    const payment = new Payment(mpClient);
    const paymentInfo = await payment.get({ id: paymentId });

    if (paymentInfo && paymentInfo.status === 'approved') {
      await aplicarPagoMercadoPago(paymentInfo);
      return res.json({ ok: true, mensaje: 'Pago de Mercado Pago verificado y aplicado' });
    }
    res.status(400).json({ ok: false, error: 'El pago aún no figura como aprobado' });
  } catch (err) {
    console.error('Error verificando pago MP:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==========================================

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

app.get('/api/mi-perfil', requireAuth, (req, res) => {
  const esMaster = (req.usuarioSesion?.usuario === (process.env.ADMIN_USER || 'admin'));
  res.json({
    ok: true,
    usuario: req.usuarioSesion?.usuario,
    nombre: esMaster ? 'Harold' : (req.usuarioSesion?.nombre || 'Harold'),
    rol: req.usuarioSesion?.rol || 'staff'
  });
});

app.put('/api/mi-perfil/password', requireAuth, async (req, res) => {
  try {
    const { passwordActual, passwordNueva } = req.body;

    if (!req.usuarioSesion || !req.usuarioSesion.id) {
      return res.status(400).json({
        ok: false,
        error: 'La contraseña del Administrador Maestro se gestiona directamente desde las variables de entorno del servidor.'
      });
    }

    if (!passwordActual || !passwordNueva || String(passwordNueva).trim().length < 4) {
      return res.status(400).json({
        ok: false,
        error: 'Debes ingresar tu contraseña actual y una nueva de al menos 4 caracteres.'
      });
    }

    if (!bcrypt) {
      return res.status(500).json({ ok: false, error: 'Módulo de encriptación no disponible.' });
    }

    const usuarioBD = await Usuario.findById(req.usuarioSesion.id);
    if (!usuarioBD) {
      return res.status(404).json({ ok: false, error: 'Usuario no encontrado en la base de datos.' });
    }

    const passwordValida = await bcrypt.compare(String(passwordActual), usuarioBD.password);
    if (!passwordValida) {
      return res.status(400).json({ ok: false, error: 'La contraseña actual es incorrecta.' });
    }

    const salt = await bcrypt.genSalt(10);
    usuarioBD.password = await bcrypt.hash(String(passwordNueva).trim(), salt);
    await usuarioBD.save();

    res.json({ ok: true, mensaje: 'Contraseña actualizada correctamente.' });
  } catch (err) {
    console.error('Error al cambiar contraseña propia:', err.message);
    res.status(500).json({ ok: false, error: 'Error al actualizar la contraseña.' });
  }
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

// ==========================================
// RUTAS DE GESTIÓN DE USUARIOS (CRUD COMPLETO)
// ==========================================

app.get('/api/usuarios', requireAuth, requireAdmin, async (req, res) => {
  try {
    const usuarios = await Usuario.find({}, '-password').sort({ createdAt: -1 }).lean();
    res.json({ ok: true, usuarios, rolActual: 'admin' });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error al obtener usuarios' });
  }
});

app.post('/api/usuarios', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { nombre, usuario, email, telefono, password, rol, activo } = req.body;
    
    if (!nombre || !usuario || !email || !password) {
      return res.status(400).json({ ok: false, error: 'Faltan campos obligatorios (nombre, usuario, email, password).' });
    }

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const nuevoUsuario = new Usuario({
      nombre: nombre.trim(),
      usuario: usuario.trim().toLowerCase(),
      email: email.trim().toLowerCase(),
      telefono: telefono ? telefono.trim() : '',
      password: hashedPassword,
      rol: rol || 'staff',
      activo: activo !== false
    });

    await nuevoUsuario.save();
    res.json({ ok: true, usuario: nuevoUsuario });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message || 'Error al registrar usuario' });
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

app.delete('/api/usuarios/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ ok: false, error: 'ID no válido' });
    }
    await Usuario.findByIdAndDelete(id);
    res.json({ ok: true, mensaje: 'Usuario eliminado correctamente' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/restaurar-fechas-pagos', requireAuth, requireAdmin, async (req, res) => {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(500).json({ ok: false, error: 'Sin conexión a MongoDB Atlas' });
    }
    const todosLosPagos = await Pago.find({});
    let actualizados = 0;

    for (const p of todosLosPagos) {
      if (p.createdAt) {
        p.fecha = p.createdAt;
        await p.save();
        actualizados++;
      }
    }

    await sincronizarMemoriaDesdeBD();
    res.json({
      ok: true,
      mensaje: `✅ Se restauraron las fechas originales de ${actualizados} pagos. Ya puedes volver al Dashboard y recargar.`
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==========================================
// MÓDULO: PROVEEDORES, CATÁLOGO Y COMPRAS
// ==========================================

app.get('/api/proveedores', requireAuth, async (req, res) => {
  try {
    const proveedores = await Proveedor.find({ activo: true }).sort({ nombre: 1 }).lean();
    res.json({ ok: true, proveedores });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error al obtener proveedores' });
  }
});

app.post('/api/proveedores', requireAuth, async (req, res) => {
  try {
    const proveedor = await Proveedor.create(req.body);
    res.status(201).json({ ok: true, proveedor });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.put('/api/proveedores/:id', requireAuth, async (req, res) => {
  try {
    const proveedor = await Proveedor.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!proveedor) return res.status(404).json({ ok: false, error: 'Proveedor no encontrado' });
    res.json({ ok: true, proveedor });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/api/proveedores/:id', requireAuth, async (req, res) => {
  try {
    await Proveedor.findByIdAndUpdate(req.params.id, { activo: false });
    res.json({ ok: true, mensaje: 'Proveedor eliminado' });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// CATÁLOGO MAESTRO DE INSUMOS Y ALIAS POR PROVEEDOR
app.get('/api/catalogo', requireAuth, async (req, res) => {
  try {
    const filtro = { activo: true };
    if (req.query.categoria) filtro.categoria = req.query.categoria;

    const catalogo = await CatalogoInsumo.find(filtro)
      .populate('equivalencias.proveedorId', 'nombre')
      .sort({ categoria: 1, modeloInterno: 1 })
      .lean();

    res.json({ ok: true, catalogo });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error al consultar el catálogo' });
  }
});

app.post('/api/catalogo', requireAuth, async (req, res) => {
  try {
    const insumo = await CatalogoInsumo.create(req.body);
    res.status(201).json({ ok: true, insumo });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.put('/api/catalogo/:id', requireAuth, async (req, res) => {
  try {
    const insumo = await CatalogoInsumo.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!insumo) return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    res.json({ ok: true, insumo });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Edición rápida de alias/costo para un proveedor específico (botón lápiz al vuelo)
app.put('/api/catalogo/:id/alias', requireAuth, async (req, res) => {
  try {
    const { proveedorId, nombreProveedor, colorProveedor, costoUnitario, diasProduccion } = req.body;
    const insumo = await CatalogoInsumo.findById(req.params.id);
    if (!insumo) return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });

    const idx = insumo.equivalencias.findIndex(
      e => String(e.proveedorId) === String(proveedorId)
    );

    if (idx >= 0) {
      insumo.equivalencias[idx].nombreProveedor = nombreProveedor;
      if (colorProveedor !== undefined) insumo.equivalencias[idx].colorProveedor = colorProveedor;
      if (costoUnitario !== undefined) insumo.equivalencias[idx].costoUnitario = Number(costoUnitario);
      if (diasProduccion !== undefined) insumo.equivalencias[idx].diasProduccion = Number(diasProduccion);
    } else {
      insumo.equivalencias.push({
        proveedorId,
        nombreProveedor,
        colorProveedor: colorProveedor || '',
        costoUnitario: costoUnitario !== undefined ? Number(costoUnitario) : 0,
        diasProduccion: diasProduccion !== undefined ? Number(diasProduccion) : 15
      });
    }

    await insumo.save();
    res.json({ ok: true, insumo });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.patch('/api/catalogo/:id/stock', requireAuth, async (req, res) => {
  try {
    const { stockDisponible } = req.body;
    const insumo = await CatalogoInsumo.findByIdAndUpdate(
      req.params.id,
      { stockDisponible: Math.max(0, Number(stockDisponible) || 0) },
      { new: true }
    );
    if (!insumo) return res.status(404).json({ ok: false, error: 'Insumo no encontrado' });
    res.json({ ok: true, insumo });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/api/catalogo/:id', requireAuth, async (req, res) => {
  try {
    await CatalogoInsumo.findByIdAndUpdate(req.params.id, { activo: false });
    res.json({ ok: true, mensaje: 'Artículo eliminado del catálogo' });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// EXPLOSIÓN DE MATERIALES POR GRUPO (REGLA: 1 MARCO TRIPLE = 2 DIPLOMAS)
  // EXPLOSIÓN DE MATERIALES POR GRUPO (LEE PAQUETE, 1 TRIPLE = 2 DIPLOMAS Y DESCUENTA PEDIDOS PREVIOS)
app.post('/api/ordenes-compra/preview-grupos', requireAuth, async (req, res) => {
  try {
    const { grupos = [], proveedorId = '' } = req.body;

    // 1. Resolver IDs y nombres de los grupos seleccionados (para cruzar Cuenta y OrdenCompra)
    let idsSeleccionados = [];
    let nombresSeleccionados = [];

    if (Array.isArray(grupos) && grupos.length > 0) {
      const objectIds = grupos
        .filter(id => mongoose.Types.ObjectId.isValid(String(id)))
        .map(id => new mongoose.Types.ObjectId(String(id)));

      const gruposDocs = await Grupo.find({
        $or: [
          ...(objectIds.length > 0 ? [{ _id: { $in: objectIds } }] : []),
          { nombre: { $in: grupos.map(String) } }
        ]
      }).lean();

      idsSeleccionados = [
        ...grupos.map(String),
        ...gruposDocs.map(g => String(g._id)),
        ...objectIds
      ];
      nombresSeleccionados = gruposDocs.map(g => g.nombre.trim());
    }

    const filtroCuentas = (Array.isArray(grupos) && grupos.length > 0)
      ? {
          $or: [
            { grupoId: { $in: idsSeleccionados } },
            ...(nombresSeleccionados.length > 0 ? [{ grupoNombre: { $in: nombresSeleccionados } }] : [])
          ]
        }
      : {};

    const cuentas = await Cuenta.find(filtroCuentas).lean();

    // 2. Contar necesidades brutas desde los paquetes de los alumnos
    const conteo = {};
    const sumar = (categoria, modelo, tamano, unidades = 1, modeloBaseFallback = '') => {
      if (!modelo || !String(modelo).trim()) return;
      const modLimpio = String(modelo).replace(/\s+/g, ' ').trim();
      const tamLimpio = String(tamano || 'ESTANDAR').replace(/\s+/g, ' ').trim();
      const clave = `${categoria}|${modLimpio.toLowerCase()}|${tamLimpio.toLowerCase()}`;

      if (!conteo[clave]) {
        conteo[clave] = {
          categoria,
          modeloInterno: modLimpio,
          modeloBaseFallback: String(modeloBaseFallback || modLimpio).replace(/\s+/g, ' ').trim(),
          tamanoOTalla: tamLimpio,
          cantidad: 0
        };
      }
      conteo[clave].cantidad += unidades;
    };

    for (const cta of cuentas) {
      // A) Marcos y Diplomas: extraer modelo desde "paquete" (ej: "Línea Deluxe 1... - Jirafa")
      const paqueteRaw = String(cta.paquete || '').trim();
      if (paqueteRaw && paqueteRaw.toLowerCase() !== 'sin paquete') {
        const partes = paqueteRaw.split(' - ');
        const modeloBase = partes.length > 1
          ? partes.slice(1).join(' - ').trim()
          : paqueteRaw;

        const acabado = String(cta.tipoPanoramica || '').trim();
        const modeloMarco = acabado ? `${modeloBase} (${acabado})` : modeloBase;

        // Regla: cada marco triple lleva automáticamente 2 diplomas del mismo modelo
        sumar('marco', modeloMarco, 'TRIPLE 8X20', 1, modeloBase);
        sumar('diploma', modeloBase, 'DIPLOMA', 2, modeloBase);
      }

      // B) Playeras / Camisas por talla
      const tallaCam = String(cta.tallaCamisa || '').trim();
      if (tallaCam && tallaCam.toLowerCase() !== 'n/a' && tallaCam !== '-') {
        sumar('playera', 'CAMISA / PLAYERA GRADUACION', tallaCam, 1);
      }

      // C) Regalías especiales (Anillo de Plata 925 y/o Personalizador)
      const eleccion = String(cta.eleccionEspecial || '').trim();
      const tallaAnillo = String(cta.tallaAnillo || '').trim();

      if (eleccion === 'Ambos (Anillo + Personalizador)') {
        sumar('anillo', 'ANILLO DE PLATA 925', tallaAnillo || 'SIN MEDIDA', 1);
        sumar('personalizador', 'PERSONALIZADOR', 'ESTANDAR', 1);
      } else if (eleccion === 'Anillo de Plata 925') {
        sumar('anillo', 'ANILLO DE PLATA 925', tallaAnillo || 'SIN MEDIDA', 1);
      } else if (eleccion.toLowerCase().includes('personalizador')) {
        sumar('personalizador', 'PERSONALIZADOR', 'ESTANDAR', 1);
      } else if (eleccion !== 'Sin regalía' && tallaAnillo !== '' && tallaAnillo !== '-') {
        sumar('anillo', 'ANILLO DE PLATA 925', tallaAnillo, 1);
      }
    }

    // 3. Consultar órdenes previas no canceladas de los mismos grupos para restar lo ya pedido
    const filtroOrdenesPrevias = { estatus: { $ne: 'cancelado' } };
    if (Array.isArray(grupos) && grupos.length > 0) {
      const criteriosGrupo = [...grupos.map(String), ...nombresSeleccionados];
      filtroOrdenesPrevias.gruposIncluidos = { $in: criteriosGrupo };
    }

    const ordenesPrevias = await OrdenCompra.find(filtroOrdenesPrevias).lean();
    const yaPedidoMapa = {};

    for (const ord of ordenesPrevias) {
      for (const it of (ord.items || [])) {
        const cat = String(it.categoria || 'marco').toLowerCase();
        const nomInt = String(it.nombreInterno || '').replace(/\s+/g, ' ').trim().toLowerCase();
        const tam = String(it.tamanoOTalla || 'ESTANDAR').replace(/\s+/g, ' ').trim().toLowerCase();
        const clavePrev = `${cat}|${nomInt}|${tam}`;

        const cubierto = (Number(it.cantidadPedida) || 0) + (Number(it.stockUsado) || 0);
        yaPedidoMapa[clavePrev] = (yaPedidoMapa[clavePrev] || 0) + cubierto;
      }
    }

    // 4. Cruzar contra el Catálogo Maestro y descontar órdenes previas + stock físico
    const catalogo = await CatalogoInsumo.find({ activo: true }).lean();

    const items = Object.values(conteo)
      .map(reqItem => {
        const claveExacta = `${reqItem.categoria}|${reqItem.modeloInterno.toLowerCase()}|${reqItem.tamanoOTalla.toLowerCase()}`;
        const yaPedido = yaPedidoMapa[claveExacta] || 0;
        const pendienteReal = Math.max(0, reqItem.cantidad - yaPedido);

        if (pendienteReal <= 0) return null;

        // Buscar primero por modelo completo (con acabado) y si no existe, por modelo base
        const match = catalogo.find(c =>
          c.categoria === reqItem.categoria &&
          c.modeloInterno.toLowerCase() === reqItem.modeloInterno.toLowerCase() &&
          c.tamanoOTalla.toLowerCase() === reqItem.tamanoOTalla.toLowerCase()
        ) || catalogo.find(c =>
          c.categoria === reqItem.categoria &&
          c.modeloInterno.toLowerCase() === reqItem.modeloBaseFallback.toLowerCase() &&
          c.tamanoOTalla.toLowerCase() === reqItem.tamanoOTalla.toLowerCase()
        );

        const eq = proveedorId
          ? match?.equivalencias?.find(e => String(e.proveedorId) === String(proveedorId))
          : match?.equivalencias?.[0];

        const stockDisponible = match?.stockDisponible || 0;
        const stockUsado = Math.min(stockDisponible, pendienteReal);
        const cantidadPedida = Math.max(0, pendienteReal - stockUsado);
        const costoUnitario = eq ? Number(eq.costoUnitario) : 0;

        return {
          insumoId: match?._id || null,
          categoria: reqItem.categoria,
          nombreInterno: reqItem.modeloInterno,
          nombreProveedor: eq ? eq.nombreProveedor : reqItem.modeloInterno,
          colorProveedor: eq ? eq.colorProveedor : (match?.colorInterno || ''),
          sinAlias: !eq,
          tamanoOTalla: reqItem.tamanoOTalla,
          cantidadBruta: reqItem.cantidad,
          yaPedidoPrevio: yaPedido,
          cantidadRequerida: pendienteReal,
          stockDisponible,
          stockUsado,
          cantidadPedida,
          costoUnitario,
          subtotal: Number((cantidadPedida * costoUnitario).toFixed(2))
        };
      })
      .filter(Boolean);

    res.json({
      ok: true,
      totalAlumnos: cuentas.length,
      items
    });
  } catch (err) {
    console.error('Error en preview-grupos:', err.message);
    res.status(500).json({ ok: false, error: 'Error al calcular necesidades de compra' });
  }
});

// ÓRDENES DE COMPRA, PRODUCCIÓN Y ANTICIPOS
app.get('/api/ordenes-compra', requireAuth, async (req, res) => {
  try {
    const filtro = {};
    if (req.query.estatus) filtro.estatus = req.query.estatus;
    if (req.query.proveedorId) filtro.proveedorId = req.query.proveedorId;

    const ordenes = await OrdenCompra.find(filtro)
      .populate('proveedorId', 'nombre telefono categoria')
      .sort({ createdAt: -1 })
      .lean();

    res.json({ ok: true, ordenes });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Error al obtener órdenes de compra' });
  }
});

app.post('/api/ordenes-compra', requireAuth, async (req, res) => {
  try {
    const {
      proveedorId,
      gruposIncluidos = [],
      fechaPromesaEntrega,
      fechaGraduacionMasProxima,
      items = [],
      notas = ''
    } = req.body;

    if (!proveedorId || items.length === 0) {
      return res.status(400).json({ ok: false, error: 'Selecciona un proveedor y al menos un artículo.' });
    }

    const anio = new Date().getFullYear();
    const conteo = await OrdenCompra.countDocuments();
    const folio = `OC-${anio}-${String(conteo + 1).padStart(3, '0')}`;

    // Si algún renglón tiene guardarAlias: true, actualiza o crea el artículo en el catálogo
    for (const item of items) {
      if (item.guardarAlias) {
        let insumo = item.insumoId ? await CatalogoInsumo.findById(item.insumoId) : null;
        if (!insumo) {
          insumo = await CatalogoInsumo.findOne({
            categoria: item.categoria || 'marco',
            modeloInterno: new RegExp(`^${String(item.nombreInterno || '').trim()}$`, 'i'),
            tamanoOTalla: new RegExp(`^${String(item.tamanoOTalla || '').trim()}$`, 'i')
          });
        }

        if (!insumo) {
          insumo = new CatalogoInsumo({
            categoria: item.categoria || 'marco',
            modeloInterno: String(item.nombreInterno || item.nombreProveedor).trim(),
            tamanoOTalla: String(item.tamanoOTalla || 'ESTANDAR').trim(),
            equivalencias: []
          });
        }

        const idx = insumo.equivalencias.findIndex(
          e => String(e.proveedorId) === String(proveedorId)
        );
        if (idx >= 0) {
          insumo.equivalencias[idx].nombreProveedor = item.nombreProveedor;
          insumo.equivalencias[idx].colorProveedor = item.colorProveedor || '';
          insumo.equivalencias[idx].costoUnitario = Number(item.costoUnitario) || 0;
        } else {
          insumo.equivalencias.push({
            proveedorId,
            nombreProveedor: item.nombreProveedor,
            colorProveedor: item.colorProveedor || '',
            costoUnitario: Number(item.costoUnitario) || 0
          });
        }
        await insumo.save();
        item.insumoId = insumo._id;
      }

      if (item.insumoId && Number(item.stockUsado) > 0) {
        await CatalogoInsumo.findByIdAndUpdate(item.insumoId, {
          $inc: { stockDisponible: -Math.abs(Number(item.stockUsado)) }
        });
      }
    }

    const nuevaOrden = new OrdenCompra({
      folio,
      proveedorId,
      gruposIncluidos,
      fechaPromesaEntrega: fechaPromesaEntrega ? new Date(fechaPromesaEntrega) : undefined,
      fechaGraduacionMasProxima: fechaGraduacionMasProxima ? new Date(fechaGraduacionMasProxima) : undefined,
      items,
      notas
    });

    await nuevaOrden.save();
    res.status(201).json({ ok: true, orden: nuevaOrden });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.patch('/api/ordenes-compra/:id/estatus', requireAuth, async (req, res) => {
  try {
    const { estatus, fechaPromesaEntrega, notas } = req.body;
    const orden = await OrdenCompra.findById(req.params.id);
    if (!orden) return res.status(404).json({ ok: false, error: 'Orden no encontrada' });

    if (estatus) orden.estatus = estatus;
    if (fechaPromesaEntrega) orden.fechaPromesaEntrega = new Date(fechaPromesaEntrega);
    if (notas !== undefined) orden.notas = notas;

    await orden.save();
    res.json({ ok: true, orden });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Registrar anticipo o abono al proveedor (y sincronizar con Egresos)
app.post('/api/ordenes-compra/:id/pagos', requireAuth, async (req, res) => {
  try {
    const { monto, metodo, referencia, nota, fecha, registrarEnEgresos = true } = req.body;
    const orden = await OrdenCompra.findById(req.params.id).populate('proveedorId', 'nombre');
    if (!orden) return res.status(404).json({ ok: false, error: 'Orden no encontrada' });

    const montoNum = Number(monto) || 0;
    if (montoNum <= 0) {
      return res.status(400).json({ ok: false, error: 'El monto debe ser mayor a 0' });
    }
    if (montoNum > orden.saldoPendiente) {
      return res.status(400).json({
        ok: false,
        error: `El pago ($${montoNum}) supera el saldo pendiente ($${orden.saldoPendiente})`
      });
    }

    const fechaPago = fecha ? new Date(fecha) : new Date();
    orden.pagos.push({
      monto: montoNum,
      metodo: metodo || 'transferencia',
      referencia: referencia || '',
      nota: nota || '',
      fecha: fechaPago
    });

    await orden.save();

    if (registrarEnEgresos) {
      const nombreProv = orden.proveedorId?.nombre || 'Proveedor';
      await Egreso.create({
        concepto: `Pago Orden ${orden.folio} - ${nombreProv}${nota ? ` (${nota})` : ''}`,
        monto: montoNum,
        categoria: 'Proveedores',
        fecha: fechaPago,
        grupoNombre: (orden.gruposIncluidos || []).join(', '),
        notas: `Ref: ${referencia || 'N/A'} | Método: ${metodo || 'transferencia'}`
      });
      await sincronizarMemoriaDesdeBD();
    }

    res.json({ ok: true, orden });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Generar PDF limpio de la Orden de Compra (con los nombres del proveedor)
app.get('/api/ordenes-compra/:id/pdf', requireAuth, async (req, res) => {
  try {
    const orden = await OrdenCompra.findById(req.params.id).populate('proveedorId', 'nombre telefono').lean();
    if (!orden) return res.status(404).send('Orden de compra no encontrada');

    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Pedido_${orden.folio}.pdf"`);
    doc.pipe(res);

    doc.fillColor('#1e3a8a').fontSize(20).text('AB GRADUACIONES', { align: 'left' });
    doc.fillColor('#3b82f6').fontSize(11).text(`ORDEN DE PRODUCCIÓN / PEDIDO: ${orden.folio}`, { align: 'left' });
    doc.moveDown(0.5);

    doc.fillColor('#0f172a').fontSize(10);
    doc.text(`Proveedor: ${orden.proveedorId?.nombre || 'Proveedor'}`);
    if (orden.proveedorId?.telefono) doc.text(`Teléfono: ${orden.proveedorId.telefono}`);
    doc.text(`Fecha de pedido: ${new Date(orden.fechaPedido).toLocaleDateString('es-MX')}`);
    if (orden.fechaPromesaEntrega) {
      doc.text(`Fecha requerida de entrega: ${new Date(orden.fechaPromesaEntrega).toLocaleDateString('es-MX')}`);
    }
    doc.moveDown();

    // Encabezado de tabla
    let y = doc.y;
    doc.rect(40, y, 515, 22).fill('#1e3a8a');
    doc.fillColor('#ffffff').fontSize(9);
    doc.text('CANT.', 46, y + 7, { width: 40 });
    doc.text('TAMAÑO / TALLA', 90, y + 7, { width: 95 });
    doc.text('MODELO (PROVEEDOR)', 190, y + 7, { width: 155 });
    doc.text('COLOR', 350, y + 7, { width: 85 });
    doc.text('P. UNIT', 438, y + 7, { width: 55, align: 'right' });
    doc.text('SUBTOTAL', 495, y + 7, { width: 55, align: 'right' });

    y += 26;
    doc.fillColor('#0f172a').fontSize(9);

    for (const item of orden.items) {
      if (y > 740) {
        doc.addPage();
        y = 40;
      }
      doc.text(String(item.cantidadPedida), 46, y, { width: 40 });
      doc.text(String(item.tamanoOTalla || ''), 90, y, { width: 95 });
      doc.text(String(item.nombreProveedor || ''), 190, y, { width: 155 });
      doc.text(String(item.colorProveedor || '-'), 350, y, { width: 85 });
      doc.text(`$${Number(item.costoUnitario || 0).toLocaleString()}`, 438, y, { width: 55, align: 'right' });
      doc.text(`$${Number(item.subtotal || 0).toLocaleString()}`, 495, y, { width: 55, align: 'right' });

      y += 22;
      doc.moveTo(40, y - 4).lineTo(555, y - 4).strokeColor('#e2e8f0').stroke();
    }

    doc.moveDown(1.5);
    const totalPiezas = orden.items.reduce((acc, it) => acc + (Number(it.cantidadPedida) || 0), 0);
    doc.fillColor('#0f172a').fontSize(11).text(`Total de piezas: ${totalPiezas}`, 40);
    doc.fontSize(12).text(`Total del pedido: $${Number(orden.totalOrden || 0).toLocaleString()} MXN`, { align: 'right' });
    doc.fillColor('#15803d').fontSize(10).text(`Anticipo / Pagado: $${Number(orden.totalPagado || 0).toLocaleString()} MXN`, { align: 'right' });
    doc.fillColor('#b45309').fontSize(11).text(`Saldo pendiente: $${Number(orden.saldoPendiente || 0).toLocaleString()} MXN`, { align: 'right' });

    if (orden.notas) {
      doc.moveDown();
      doc.fillColor('#334155').fontSize(9).text(`Notas: ${orden.notas}`, 40);
    }

    doc.end();
  } catch (err) {
    res.status(500).send('Error al generar PDF de orden de compra');
  }
});

app.delete('/api/ordenes-compra/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    await OrdenCompra.findByIdAndDelete(req.params.id);
    res.json({ ok: true, mensaje: 'Orden de compra eliminada' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ==========================================

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