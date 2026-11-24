require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const mongoUri = process.env.MONGODB_URI || process.env.MONGOOSE_URI;

if (!mongoUri) {
  console.error('❌ No se encontró la URI de MongoDB en el archivo .env');
  process.exit(1);
}

// 1. Esquema directo sin buffering previo
const UsuarioSchema = new mongoose.Schema({
  nombre: { type: String, required: true, trim: true },
  usuario: { type: String, required: true, unique: true, trim: true, lowercase: true },
  email: { type: String, required: true, unique: true, trim: true, lowercase: true },
  telefono: { type: String, trim: true },
  password: { type: String, required: true },
  rol: { type: String, enum: ['admin', 'staff'], default: 'staff' },
  activo: { type: Boolean, default: true }
}, {
  timestamps: true,
  bufferCommands: false
});

async function sembrar() {
  let conn = null;

  try {
    console.log('🔄 Conectando a MongoDB Atlas...');

    conn = await mongoose.createConnection(mongoUri, {
      serverSelectionTimeoutMS: 20000,
      connectTimeoutMS: 20000,
      family: 4
    }).asPromise();

    console.log('✅ Conexión establecida y confirmada.');

    const Usuario = conn.model('Usuario', UsuarioSchema);

    // Coloca aquí los datos reales de tus colaboradores y la contraseña que ellos elijan
    const listaUsuarios = [
      {
        nombre: 'Aaron Brigido Leon',
        usuario: 'ABL',
        email: 'abstudiophoto@gmail.com',
        telefono: '+529512202999',
        passwordPlano: 'ClaveSegura123', // Contraseña elegida
        rol: 'admin',
        activo: true
      },
      {
        nombre: 'Yaneli Garcia Garcia',
        usuario: 'YaneliGG',
        email: 'yane@gmail.com',
        telefono: '+525500000002',
        passwordPlano: 'ClaveSegura456', // Contraseña elegida
        rol: 'admin',
        activo: true
      }
    ];

    for (const u of listaUsuarios) {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(u.passwordPlano, salt);

      // findOneAndUpdate con upsert: actualiza los datos y la contraseña si ya existe, o lo crea si es nuevo
      await Usuario.findOneAndUpdate(
        { usuario: u.usuario.toLowerCase() },
        {
          nombre: u.nombre,
          usuario: u.usuario.toLowerCase(),
          email: u.email.toLowerCase(),
          telefono: u.telefono,
          password: hashedPassword,
          rol: u.rol,
          activo: u.activo
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      );

      console.log(`✅ Usuario configurado y actualizado: ${u.usuario} (${u.email})`);
    }

    console.log('🏁 Proceso finalizado exitosamente.');
    await conn.close();
    process.exit(0);
  } catch (err) {
    console.error('❌ Error durante la configuración de usuarios:', err.message);
    if (conn) {
      await conn.close();
    }
    process.exit(1);
  }
}

sembrar();