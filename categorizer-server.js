const express = require("express");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(express.json());

const { ODOO_URL, DB, USER, PASS, ANTHROPIC_API_KEY } = process.env;

const PROCESSED_FILE = path.join(__dirname, "processed_ids.json");
const INTERVAL_MS    = 15000;

// ─────────────────────────────────────────
// ESTADO EN MEMORIA
// ─────────────────────────────────────────

let isRunning    = false;
let isPaused     = false;
let currentTimer = null;
let stats = { processed: 0, categorized: 0, errors: 0, skipped: 0, startedAt: null };

// ─────────────────────────────────────────
// PERSISTENCIA DE IDs PROCESADOS
// ─────────────────────────────────────────

function loadProcessed() {
  try {
    if (fs.existsSync(PROCESSED_FILE)) {
      return new Set(JSON.parse(fs.readFileSync(PROCESSED_FILE, "utf8")));
    }
  } catch (e) {
    console.error("⚠️  No se pudo leer processed_ids.json, empezando vacío:", e.message);
  }
  return new Set();
}

function saveProcessed(set) {
  try {
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...set]), "utf8");
  } catch (e) {
    console.error("⚠️  No se pudo guardar processed_ids.json:", e.message);
  }
}

const processedIds = loadProcessed();
console.log(`📂 IDs ya procesados cargados: ${processedIds.size}`);

// ─────────────────────────────────────────
// CATÁLOGO DE CATEGORÍAS
// ─────────────────────────────────────────

const CATEGORY_CATALOG = [
  { name: "PRENDAS SUPERIORES",      parent: "ROPA",                    examples: "playeras, camisetas, tops deportivos, jerseys, camisetas térmicas" },
  { name: "PRENDAS INFERIORES",      parent: "ROPA",                    examples: "shorts, leggings, pants deportivos" },
  { name: "ABRIGO Y EXTERIOR",       parent: "ROPA",                    examples: "sudaderas, chamarras, cortavientos" },
  { name: "ROPA INTERIOR Y BAÑO",    parent: "ROPA",                    examples: "calcetines, bañadores, trajes de natación" },
  { name: "RUNNING Y ENTRENAMIENTO", parent: "CALZADO",                 examples: "tenis para correr, tenis de gym, cross training" },
  { name: "TACHONES",                parent: "CALZADO",                 examples: "tachones de fútbol, rugby, americano, béisbol" },
  { name: "CANCHA - INDOOR",         parent: "CALZADO",                 examples: "tenis de futsal, básquetbol, voleibol" },
  { name: "CASUAL - SNEAKERS",       parent: "CALZADO",                 examples: "tenis lifestyle, uso diario deportivo" },
  { name: "SANDALIAS Y CHANCLAS",    parent: "CALZADO",                 examples: "chanclas deportivas, sandalias de recuperación" },
  { name: "PELOTAS Y BALONES",       parent: "EQUIPAMIENTO Y MATERIAL", examples: "balones de fútbol, básquetbol, voleibol" },
  { name: "RAQUETAS Y PALAS",        parent: "EQUIPAMIENTO Y MATERIAL", examples: "palas de pádel, raquetas de tenis, bádminton" },
  { name: "PROTECCIONES",            parent: "EQUIPAMIENTO Y MATERIAL", examples: "espinilleras, cascos, guantes de box, rodilleras" },
  { name: "ENTRENAMIENTO EN CASA",   parent: "EQUIPAMIENTO Y MATERIAL", examples: "mancuernas, ligas, esterillas, cuerdas" },
  { name: "PARAMÉDICOS",             parent: "EQUIPAMIENTO Y MATERIAL", examples: "soporte, recuperación, primeros auxilios en general" },
  { name: "RECUPERACIÓN",            parent: "PARAMÉDICOS",             examples: "foam rollers, pelotas de masaje, bandas de recuperación" },
  { name: "SOPORTE Y PREVENCIÓN",    parent: "PARAMÉDICOS",             examples: "rodilleras, tobilleras, muñequeras, fajas" },
  { name: "PRIMEROS AUXILIOS",       parent: "PARAMÉDICOS",             examples: "vendajes, compresas frío/calor, kits de emergencia" },
  { name: "BOLSAS Y MOCHILAS",       parent: "ACCESORIOS",              examples: "mochilas deportivas, maletas, mochilas de hidratación" },
  { name: "ELECTRÓNICA",             parent: "ACCESORIOS",              examples: "relojes deportivos, audífonos, bandas inteligentes" },
  { name: "COMPLEMENTOS",            parent: "ACCESORIOS",              examples: "gorras, botellas de agua, bidones, muñequeras" },
  { name: "CUIDADO Y MANTENIMIENTO", parent: "ACCESORIOS",              examples: "limpia calzado, spray desodorante, cintas deportivas" },
];

const SYSTEM_PROMPT = `Eres un clasificador de productos deportivos. Recibes el nombre y referencia de UN producto y debes asignar la categoría más apropiada del catálogo.

CATÁLOGO:
${CATEGORY_CATALOG.map(c => `- "${c.name}" (padre: ${c.parent}) → ${c.examples}`).join("\n")}

Responde ÚNICAMENTE con JSON válido sin markdown:
{ "category": "<NOMBRE_EXACTO_DEL_CATÁLOGO>", "confidence": <0.0-1.0> }

Si no encaja en ninguna categoría usa: { "category": "SIN_CATEGORIA", "confidence": 0 }`;

// ─────────────────────────────────────────
// FUNCIONES CORE
// ─────────────────────────────────────────

async function odooCall(service, method, args) {
  const response = await fetch(ODOO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", method: "call",
      params: { service, method, args },
      id: Math.random()
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.result;
}

const categIdCache = {};
async function getCategId(uid, categoryName) {
  if (categIdCache[categoryName]) return categIdCache[categoryName];
  const found = await odooCall("object", "execute_kw", [
    DB, uid, PASS,
    "product.category", "search_read",
    [[["name", "=", categoryName]]],
    { fields: ["id", "name"], limit: 1 }
  ]);
  if (!found.length) {
    console.warn(`⚠️  Categoría "${categoryName}" no encontrada en Odoo`);
    return null;
  }
  categIdCache[categoryName] = found[0].id;
  return found[0].id;
}

async function classifyWithAI(product) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 128,
      system: SYSTEM_PROMPT,
      messages: [{
        role: "user",
        content: `Nombre: ${product.name}\nReferencia: ${product.default_code || "sin referencia"}`
      }]
    })
  });

  if (!response.ok) throw new Error(`Claude API ${response.status}: ${await response.text()}`);
  const data = await response.json();
  const text = data.content[0].text.trim().replace(/```json|```/g, "").trim();
  return JSON.parse(text);
}

// ─────────────────────────────────────────
// LOOP PRINCIPAL — un producto cada 15 segundos
// ─────────────────────────────────────────

async function processNext() {
  if (isPaused || !isRunning) return;

  let uid;
  try {
    uid = await odooCall("common", "login", [DB, USER, PASS]);
  } catch (e) {
    console.error("❌ No se pudo conectar a Odoo:", e.message);
    scheduleNext();
    return;
  }

  // Buscar siguiente producto no procesado, paginando en lotes de 50
  let product = null;
  let offset = 0;
  while (!product) {
    const batch = await odooCall("object", "execute_kw", [
      DB, uid, PASS,
      "product.template", "search_read",
      [[]],
      { fields: ["id", "name", "default_code", "categ_id"], limit: 50, offset }
    ]);

    if (!batch.length) {
      console.log("🏁 Todos los productos han sido procesados.");
      isRunning = false;
      return;
    }

    product = batch.find(p => !processedIds.has(p.id));
    if (!product) offset += 50;
  }

  const label = `[${product.id}] "${product.name}"`;
  stats.processed++;

  try {
    const result = await classifyWithAI(product);
    console.log(`🤖 ${label} → "${result.category}" (confianza: ${result.confidence})`);

    if (result.category === "SIN_CATEGORIA" || result.confidence < 0.75) {
      console.log(`⏭️  ${label} omitido — confianza insuficiente`);
      stats.skipped++;
    } else {
      const categId = await getCategId(uid, result.category);
      if (!categId) {
        console.warn(`⚠️  ${label} — categ_id no encontrado para "${result.category}"`);
        stats.errors++;
      } else {
        await odooCall("object", "execute_kw", [
          DB, uid, PASS,
          "product.template", "write",
          [[product.id], { categ_id: categId }]
        ]);
        console.log(`✅ ${label} → "${result.category}" (categ_id: ${categId})`);
        stats.categorized++;
      }
    }
  } catch (e) {
    console.error(`❌ ${label} — error:`, e.message);
    stats.errors++;
  }

  processedIds.add(product.id);
  saveProcessed(processedIds);

  scheduleNext();
}

function scheduleNext() {
  if (!isRunning || isPaused) return;
  currentTimer = setTimeout(processNext, INTERVAL_MS);
}

// ─────────────────────────────────────────
// ENDPOINTS DE CONTROL
// ─────────────────────────────────────────

app.post("/start", (req, res) => {
  if (isRunning && !isPaused) return res.json({ message: "Ya está corriendo.", stats });
  if (isPaused) {
    isPaused = false;
    scheduleNext();
    console.log("▶️  Reanudado");
    return res.json({ message: "Reanudado.", stats });
  }
  isRunning = true;
  isPaused  = false;
  stats     = { processed: 0, categorized: 0, errors: 0, skipped: 0, startedAt: new Date().toISOString() };
  console.log("▶️  Iniciando loop de categorización...");
  processNext();
  res.json({ message: "Iniciado.", stats });
});

app.post("/pause", (req, res) => {
  if (!isRunning) return res.json({ message: "No está corriendo." });
  isPaused = true;
  if (currentTimer) clearTimeout(currentTimer);
  console.log("⏸️  Pausado");
  res.json({ message: "Pausado.", stats });
});

app.post("/stop", (req, res) => {
  isRunning = false;
  isPaused  = false;
  if (currentTimer) clearTimeout(currentTimer);
  console.log("⏹️  Detenido");
  res.json({ message: "Detenido. IDs procesados conservados.", stats });
});

app.get("/status", (req, res) => {
  res.json({ isRunning, isPaused, totalProcessed: processedIds.size, sessionStats: stats });
});

app.post("/reset-processed", (req, res) => {
  isRunning = false;
  if (currentTimer) clearTimeout(currentTimer);
  processedIds.clear();
  saveProcessed(processedIds);
  console.log("🗑️  Lista de IDs procesados borrada");
  res.json({ message: "Lista reseteada. Llama /start para re-procesar todo." });
});

app.post("/reprocess/:id", (req, res) => {
  const id = parseInt(req.params.id);
  if (processedIds.has(id)) {
    processedIds.delete(id);
    saveProcessed(processedIds);
    res.json({ message: `Producto ${id} removido. Se procesará en el siguiente ciclo.` });
  } else {
    res.json({ message: `Producto ${id} no estaba en la lista.` });
  }
});

app.get("/health", (req, res) => res.send("OK"));

// ─────────────────────────────────────────
// ARRANQUE
// ─────────────────────────────────────────

const PORT = process.env.CATEGORIZER_PORT || 3001;
app.listen(PORT, () => {
  console.log(`🚀 Categorizer corriendo en puerto ${PORT}`);
  console.log(`   POST /start            — iniciar o reanudar`);
  console.log(`   POST /pause            — pausar`);
  console.log(`   POST /stop             — detener`);
  console.log(`   GET  /status           — ver estado y stats`);
  console.log(`   POST /reset-processed  — borrar lista de IDs`);
  console.log(`   POST /reprocess/:id    — re-procesar un producto`);
});
