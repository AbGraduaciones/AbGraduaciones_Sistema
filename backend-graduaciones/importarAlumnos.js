require('dotenv').config();
const mongoose = require('mongoose');
const xlsx = require('xlsx');
const path = require('path');

let Cliente;
try {
  Cliente = require('./models/Cliente');
} catch (e) {
  Cliente = mongoose.model('Cliente', new mongoose.Schema({
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
}

function formatearTelefono(telRaw) {
  if (!telRaw) return '+52 0000000000';
  let str = String(telRaw).trim();
  let soloDigitos = str.replace(/\D/g, '');
  if (str.startsWith('+')) return str;
  if (soloDigitos.length === 10) return `+52 ${soloDigitos}`;
  return `+${soloDigitos}`;
}

async function importarExcel() {
  try {
    const mongoUri = process.env.MONGODB_URI || process.env.MONGOOSE_URI;
    if (!mongoUri) {
      console.error('❌ Error: No se encontró la variable MONGODB_URI en .env');
      process.exit(1);
    }
    await mongoose.connect(mongoUri);

    const rutaArchivo = path.join(__dirname, 'alumnos.xlsx');
    const workbook = xlsx.readFile(rutaArchivo);
    
    // Usar la primera hoja o LISTA OFICIAL
    const nombreHoja = workbook.SheetNames.includes('LISTA OFICIAL') ? 'LISTA OFICIAL' : workbook.SheetNames[0];
    const hoja = workbook.Sheets[nombreHoja];
    
    // Leemos la hoja como matriz cruda (filas y columnas)
    const matriz = xlsx.utils.sheet_to_json(hoja, { header: 1, defval: '' });

    if (!matriz || matriz.length === 0) {
      console.log('⚠️ El archivo Excel está completamente vacío.');
      process.exit(0);
    }

    // 1. Buscar la fila donde están los encabezados
    let filaEncabezadosIdx = -1;
    let colNombre = -1;
    let colTelefono = -1;
    let colUniversidad = -1;
    let colFacultad = -1;

    for (let r = 0; r < Math.min(10, matriz.length); r++) {
      const fila = matriz[r].map(c => String(c).trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""));
      const nIdx = fila.findIndex(c => c.includes('nombre'));
      if (nIdx !== -1) {
        filaEncabezadosIdx = r;
        colNombre = nIdx;
        colTelefono = fila.findIndex(c => c.includes('tel'));
        colUniversidad = fila.findIndex(c => c.includes('universidad'));
        colFacultad = fila.findIndex(c => c.includes('facultad') || c.includes('carrera'));
        break;
      }
    }

    if (filaEncabezadosIdx === -1 || colNombre === -1) {
      console.error('❌ No se encontró la columna de NOMBRE en las primeras filas del archivo.');
      console.log('Primeras 3 filas detectadas en el Excel:');
      console.dir(matriz.slice(0, 3));
      process.exit(1);
    }

    console.log(`📌 Encabezados encontrados en fila ${filaEncabezadosIdx + 1}:`);
    console.log(`   Columna Nombre: índice ${colNombre}`);
    console.log(`   Columna Teléfono: índice ${colTelefono}`);
    console.log(`   Columna Universidad: índice ${colUniversidad}`);
    console.log(`   Columna Carrera: índice ${colFacultad}`);

    // Determinar siguiente ID
    const maxIdCliente = await Cliente.findOne({}, 'id').sort({ id: -1 });
    let maxId = 1041;
    if (maxIdCliente && maxIdCliente.id) {
      const num = parseInt(String(maxIdCliente.id).replace(/\D/g, ''), 10);
      if (!isNaN(num) && num > maxId) maxId = num;
    }

    let siguienteId = maxId + 1;
    let importados = 0;

    // 2. Procesar filas de datos a partir de la siguiente fila a los encabezados
    for (let i = filaEncabezadosIdx + 1; i < matriz.length; i++) {
      const fila = matriz[i];
      if (!fila || fila.length === 0) continue;

      const nombre = colNombre !== -1 && fila[colNombre] ? String(fila[colNombre]).trim() : '';
      if (!nombre) continue; // Omitir si la celda de nombre está vacía

      const telefonoRaw = colTelefono !== -1 && fila[colTelefono] ? fila[colTelefono] : '';
      const universidad = colUniversidad !== -1 && fila[colUniversidad] ? String(fila[colUniversidad]).trim() : '';
      const facultadCarrera = colFacultad !== -1 && fila[colFacultad] ? String(fila[colFacultad]).trim() : '';

      const idGenerado = String(siguienteId);
      const telefonoFinal = formatearTelefono(telefonoRaw);

      await Cliente.findOneAndUpdate(
        { id: idGenerado },
        {
          id: idGenerado,
          nombre,
          email: '',
          telefono: telefonoFinal,
          universidad,
          facultad: facultadCarrera,
          escuela: facultadCarrera,
          grupoId: null,
          grupoNombre: ''
        },
        { upsert: true, new: true }
      );

      console.log(`➕ Registrado [ID: ${idGenerado}] - ${nombre}`);
      siguienteId++;
      importados++;
    }

    console.log(`\n🎉 ¡Carga masiva completada! Se agregaron ${importados} alumnos.`);
    process.exit(0);
  } catch (error) {
    console.error('❌ Error durante la importación:', error);
    process.exit(1);
  }
}

importarExcel();