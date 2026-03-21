const express = require("express");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const app = express();
app.use(express.json());

const { ODOO_URL, DB, USER, PASS, ANTHROPIC_API_KEY } = process.env;

const PROCESSED_FILE = path.join(__dirname, "processed_ids.json");
const RULES_FILE     = path.join(__dirname, "learned_rules.json");
const INTERVAL_MS    = 15000;
const GITHUB_REPO      = "carlosmirandaa23/odoo-categorizer";
const GITHUB_RULES_PATH = "learned_rules.json";
const GITHUB_IDS_PATH   = "processed_ids.json";

// ─────────────────────────────────────────
// ESTADO EN MEMORIA
// ─────────────────────────────────────────

let processedIds = new Set();
let isRunning    = false;
let isPaused     = false;
let currentTimer = null;
let stats = { processed: 0, categorized: 0, errors: 0, skipped: 0, startedAt: null };

// ─────────────────────────────────────────
// PERSISTENCIA EN GITHUB
// ─────────────────────────────────────────

async function loadProcessed() {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_IDS_PATH}`,
      { headers: { Authorization: `token ${process.env.GITHUB_TOKEN}` } }
    );
    if (!res.ok) return new Set();
    const data = await res.json();
    const content = Buffer.from(data.content, "base64").toString("utf8");
    return new Set(JSON.parse(content));
  } catch (e) {
    console.error("⚠️  No se pudo leer de GitHub, empezando vacío:", e.message);
    return new Set();
  }
}

async function saveProcessed(set) {
  try {
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...set]), "utf8");
    const content = Buffer.from(JSON.stringify([...set])).toString("base64");
    const getRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_IDS_PATH}`,
      { headers: { Authorization: `token ${process.env.GITHUB_TOKEN}` } }
    );
    const getData = await getRes.json();
    await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_IDS_PATH}`,
      {
        method: "PUT",
        headers: {
          Authorization: `token ${process.env.GITHUB_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: "update processed ids",
          content,
          sha: getData.sha
        })
      }
    );
  } catch (e) {
    console.error("⚠️  No se pudo guardar en GitHub:", e.message);
  }
}

// ─────────────────────────────────────────
// REGLAS APRENDIDAS POR IA
// ─────────────────────────────────────────

let learnedRules = [];

async function loadRules() {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_RULES_PATH}`,
      { headers: { Authorization: `token ${process.env.GITHUB_TOKEN}` } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    const rules = JSON.parse(Buffer.from(data.content, "base64").toString("utf8"));
    console.log(`📚 ${rules.length} reglas aprendidas cargadas desde GitHub`);
    return rules;
  } catch (e) {
    console.error("⚠️  No se pudieron cargar reglas:", e.message);
    return [];
  }
}

async function saveRules(rules) {
  try {
    fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2), "utf8");
    const content = Buffer.from(JSON.stringify(rules, null, 2)).toString("base64");
    const getRes = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_RULES_PATH}`,
      { headers: { Authorization: `token ${process.env.GITHUB_TOKEN}` } }
    );
    const sha = getRes.ok ? (await getRes.json()).sha : undefined;
    await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_RULES_PATH}`,
      {
        method: "PUT",
        headers: {
          Authorization: `token ${process.env.GITHUB_TOKEN}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          message: "update learned rules",
          content,
          ...(sha ? { sha } : {})
        })
      }
    );
  } catch (e) {
    console.error("⚠️  No se pudieron guardar reglas:", e.message);
  }
}

function applyLearnedRules(name) {
  const lower = name.toLowerCase();
  for (const rule of learnedRules) {
    if (rule.type === "any" && rule.keywords.some(k => lower.includes(k)))  return rule.category;
    if (rule.type === "all" && rule.keywords.every(k => lower.includes(k))) return rule.category;
  }
  return null;
}

function applyExclusionRule(name) {
  const lower = name.toLowerCase();
  for (const rule of learnedRules) {
    if (rule.type === "exclude") {
      if (rule.match === "startswith" && lower.startsWith(rule.keywords[0])) return true;
      if (rule.match === "contains"   && rule.keywords.some(k => lower.includes(k))) return true;
      if (!rule.match                 && rule.keywords.some(k => lower.includes(k))) return true;
    }
  }
  return false;
}

function ruleAlreadyExists(rule) {
  return learnedRules.some(r =>
    r.type === rule.type &&
    r.keywords.length === rule.keywords.length &&
    r.keywords.every(k => rule.keywords.includes(k))
  );
}

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

function buildSystemPrompt() {
  return `Eres un clasificador de productos deportivos Y generador de reglas de clasificación.

CATÁLOGO DISPONIBLE:
${CATEGORY_CATALOG.map(c => `- "${c.name}" (padre: ${c.parent}) → ${c.examples}`).join("\n")}

Tu tarea es:
1. Clasificar el producto en la categoría correcta
2. Proponer UNA regla simple y reutilizable que capture productos similares

CRITERIOS PARA PROPONER REGLA:
- Si UNA palabra sola identifica el tipo sin ambigüedad (ej: "short", "gorra", "helmet") → type: "any", una keyword
- Si necesitas DOS palabras para evitar confusión (ej: "spotlight"+"football", "pala"+"padel") → type: "all", dos keywords  
- Las keywords deben estar en minúsculas y ser lo más genéricas posible
- Si el nombre es demasiado específico, críptico o ambiguo → rule: null
- NO propongas reglas con marcas genéricas como "nike", "adidas", "under armour"

Responde ÚNICAMENTE con JSON válido sin markdown ni texto adicional:
{
  "category": "<NOMBRE_EXACTO_DEL_CATÁLOGO>",
  "confidence": <0.0-1.0>,
  "rule": {
    "type": "any|all",
    "keywords": ["keyword1"],
    "reason": "explicación breve de por qué esta regla es confiable"
  }
}

Si no encaja en ninguna categoría: { "category": "SIN_CATEGORIA", "confidence": 0, "rule": null }
Si no hay regla confiable que proponer: incluye "rule": null en la respuesta

TIPO ESPECIAL DE REGLA — "exclude":
Si el nombre claramente NO es un producto (descuentos, porcentajes, notas, abonos, textos promocionales):
- Responde con category: "SIN_CATEGORIA", confidence: 0
- Propón una regla de exclusión:
  { "type": "exclude", "match": "startswith|contains", "keywords": ["patron"], "reason": "..." }
- Ejemplo: "10% en tu orden" → exclude startswith "10%"
- Ejemplo: "abono" → exclude contains "abono"`;
}

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
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system: buildSystemPrompt(),
      messages: [{
        role: "user",
        content: `Nombre: ${product.name}\nReferencia: ${product.default_code || "sin referencia"}`
      }]
    })
  });

  if (!response.ok) throw new Error(`Claude API ${response.status}: ${await response.text()}`);
  const data = await response.json();
  let text = data.content[0].text.trim().replace(/```json|```/g, "").trim();
  // Extraer solo el primer objeto JSON válido si hay texto extra
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`Respuesta no contiene JSON válido: ${text.slice(0, 100)}`);
  return JSON.parse(match[0]);
}

// ─────────────────────────────────────────
// LOOP PRINCIPAL — un producto cada 15s
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
    let finalCategory = null;
    let source = "";

    // Intento 1: reglas aprendidas por IA
    if (!finalCategory) {
      const learnedCategory = applyLearnedRules(product.name);
      if (learnedCategory) {
        finalCategory = learnedCategory;
        source = "regla aprendida";
        console.log(`🧠 ${label} → "${finalCategory}" (regla aprendida)`);
      }
    }

    // Intento 2a: regla de exclusión aprendida → sin gastar tokens
    if (!finalCategory && applyExclusionRule(product.name)) {
      const insufId = await getCategId(uid, "INFORMACIÓN INSUFICIENTE");
      if (insufId) {
        await odooCall("object", "execute_kw", [
          DB, uid, PASS,
          "product.template", "write",
          [[product.id], { categ_id: insufId }]
        ]);
      }
      console.log(`🚫 ${label} — excluido por regla → INFORMACIÓN INSUFICIENTE`);
      stats.skipped++;
      processedIds.add(product.id);
      saveProcessed(processedIds);
      scheduleNext();
      return;
    }

    // Intento 2b: nombre insuficiente → INFORMACIÓN INSUFICIENTE sin gastar tokens
    if (!finalCategory) {
      const wordCount = product.name.trim().split(/\s+/).filter(w => w.length > 1).length;
      if (wordCount < 3) {
        const insufId = await getCategId(uid, "INFORMACIÓN INSUFICIENTE");
        if (insufId) {
          await odooCall("object", "execute_kw", [
            DB, uid, PASS,
            "product.template", "write",
            [[product.id], { categ_id: insufId }]
          ]);
        }
        console.log(`⚠️  ${label} — nombre insuficiente (${wordCount} palabras) → INFORMACIÓN INSUFICIENTE`);
        stats.skipped++;
        processedIds.add(product.id);
        saveProcessed(processedIds);
        scheduleNext();
        return;
      }
    }

    // Intento 3: Claude clasifica Y propone regla nueva
    if (!finalCategory) {
      const result = await classifyWithAI(product);
      console.log(`🤖 ${label} → "${result.category}" (confianza: ${result.confidence})`);

      if (result.category !== "SIN_CATEGORIA" && result.confidence >= 0.75) {
        finalCategory = result.category;
        source = "claude";

        // Si Claude propuso una regla válida y no existe aún, guardarla
        if (result.rule && result.rule.keywords?.length > 0 && !ruleAlreadyExists(result.rule)) {
          const newRule = {
            type:     result.rule.type,
            keywords: result.rule.keywords.map(k => k.toLowerCase()),
            category: result.rule.type === "exclude" ? "EXCLUIDO" : result.category,
            match:    result.rule.match || null,
            reason:   result.rule.reason || "",
            example:  product.name,
            addedAt:  new Date().toISOString()
          };
          learnedRules.push(newRule);
          saveRules(learnedRules);
          const icon = result.rule.type === "exclude" ? "🚫" : "💡";
          console.log(`${icon} Nueva regla aprendida [${result.rule.type}]: ${JSON.stringify(newRule.keywords)} → "${newRule.category}"`);
        }
      } else {
        console.log(`⏭️  ${label} omitido — confianza insuficiente`);
        stats.skipped++;
      }
    }

    if (finalCategory) {
      const categId = await getCategId(uid, finalCategory);
      if (!categId) {
        console.warn(`⚠️  ${label} — categ_id no encontrado para "${finalCategory}"`);
        stats.errors++;
      } else {
        await odooCall("object", "execute_kw", [
          DB, uid, PASS,
          "product.template", "write",
          [[product.id], { categ_id: categId }]
        ]);
        console.log(`✅ ${label} → "${finalCategory}" (categ_id: ${categId})`);
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

(async () => {
  processedIds  = await loadProcessed();
  learnedRules  = await loadRules();
  console.log(`📂 IDs ya procesados cargados: ${processedIds.size}`);

  const PORT = process.env.CATEGORIZER_PORT || 3001;
  app.listen(PORT, () => {
    console.log(`🚀 Categorizer corriendo en puerto ${PORT}`);
    console.log(`   POST /pause            — pausar`);
    console.log(`   POST /stop             — detener`);
    console.log(`   GET  /status           — ver estado y stats`);
    console.log(`   POST /reset-processed  — borrar lista de IDs`);
    console.log(`   POST /reprocess/:id    — re-procesar un producto`);
  });

  isRunning = true;
  stats = { processed: 0, categorized: 0, errors: 0, skipped: 0, startedAt: new Date().toISOString() };
  console.log("▶️  Arrancando loop automáticamente...");
  processNext();
})();
