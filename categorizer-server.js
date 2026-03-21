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
const GITHUB_REPO       = "carlosmirandaa23/odoo-categorizer";
const GITHUB_RULES_PATH = "learned_rules.json";
const GITHUB_IDS_PATH   = "processed_ids.json";
const GITHUB_ERRORS_PATH = "error_logs.txt";

// ─────────────────────────────────────────
// ESTADO EN MEMORIA
// ─────────────────────────────────────────

let processedIds = new Set();
let learnedRules = [];
let isRunning    = false;
let isPaused     = false;
let currentTimer = null;
let stats = { processed: 0, categorized: 0, errors: 0, skipped: 0, startedAt: null };
const claudeLogs = [];

// ─────────────────────────────────────────
// PERSISTENCIA EN GITHUB
// ─────────────────────────────────────────

async function githubGet(filePath) {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`,
    { headers: { Authorization: `token ${process.env.GITHUB_TOKEN}` } }
  );
  if (!res.ok) return null;
  return await res.json();
}

async function githubPut(filePath, content, message, sha) {
  await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${filePath}`,
    {
      method: "PUT",
      headers: {
        Authorization: `token ${process.env.GITHUB_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message,
        content: Buffer.from(content).toString("base64"),
        ...(sha ? { sha } : {})
      })
    }
  );
}

async function loadProcessed() {
  try {
    const data = await githubGet(GITHUB_IDS_PATH);
    if (!data) return new Set();
    return new Set(JSON.parse(Buffer.from(data.content, "base64").toString("utf8")));
  } catch (e) {
    console.error("⚠️  No se pudo leer processed_ids:", e.message);
    return new Set();
  }
}

async function saveProcessed(set) {
  try {
    const json = JSON.stringify([...set]);
    fs.writeFileSync(PROCESSED_FILE, json, "utf8");
    const data = await githubGet(GITHUB_IDS_PATH);
    await githubPut(GITHUB_IDS_PATH, json, "update processed ids", data?.sha);
  } catch (e) {
    console.error("⚠️  No se pudo guardar processed_ids:", e.message);
  }
}

async function loadRules() {
  try {
    const data = await githubGet(GITHUB_RULES_PATH);
    if (!data) return [];
    const rules = JSON.parse(Buffer.from(data.content, "base64").toString("utf8"));
    console.log(`📚 ${rules.length} reglas aprendidas cargadas`);
    return rules;
  } catch (e) {
    console.error("⚠️  No se pudieron cargar reglas:", e.message);
    return [];
  }
}

async function saveRules(rules) {
  try {
    const json = JSON.stringify(rules, null, 2);
    fs.writeFileSync(RULES_FILE, json, "utf8");
    const data = await githubGet(GITHUB_RULES_PATH);
    await githubPut(GITHUB_RULES_PATH, json, "update learned rules", data?.sha);
  } catch (e) {
    console.error("⚠️  No se pudieron guardar reglas:", e.message);
  }
}

async function appendErrorLog(entry) {
  try {
    const data = await githubGet(GITHUB_ERRORS_PATH);
    const current = data ? Buffer.from(data.content, "base64").toString("utf8") : "";
    const newLine = `[${entry.at}] ${entry.type} [${entry.productId}] "${entry.productName}" — ${entry.message}\n`;
    await githubPut(GITHUB_ERRORS_PATH, newLine + current, "append error log", data?.sha);
  } catch (e) {
    console.error("⚠️  No se pudo guardar error log:", e.message);
  }
}

// ─────────────────────────────────────────
// REGLAS
// ─────────────────────────────────────────

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
    if (rule.type !== "exclude") continue;
    if (rule.match === "startswith" && lower.startsWith(rule.keywords[0])) return true;
    if (rule.match === "contains"   && rule.keywords.some(k => lower.includes(k))) return true;
    if (!rule.match                 && rule.keywords.some(k => lower.includes(k))) return true;
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
// CATÁLOGO
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

IMPORTANTE: No tienes acceso a internet ni herramientas de búsqueda. Responde ÚNICAMENTE con el JSON en tu primer y único mensaje. Sin texto previo, sin explicaciones, sin introducciones, sin disculpas. Solo el JSON.

CATÁLOGO DISPONIBLE:
${CATEGORY_CATALOG.map(c => `- "${c.name}" (padre: ${c.parent}) → ${c.examples}`).join("\n")}

TAREA:
1. Clasificar el producto en la categoría correcta del catálogo
2. Proponer UNA regla SOLO si estás completamente seguro

CRITERIOS ESTRICTOS PARA PROPONER REGLA:

USA type "any" ÚNICAMENTE cuando la palabra NUNCA puede referirse a otro tipo de producto:
- Válidos: "backpack", "tobillera", "mouthguard", "chest protector", "tricep bar"
- INVÁLIDOS: "pala" (herramienta), "catcher" (múltiples usos), "padel" (disciplina sola)

USA type "all" cuando necesitas dos palabras para evitar ambigüedad:
- Válidos: "pala"+"padel", "gloves"+"football", "shoulder"+"pads"
- Prefiere SIEMPRE "all" sobre "any" cuando tengas la mínima duda

NUNCA propongas regla con:
- Marcas: "nike", "adidas", "under armour", "wilson", etc.
- Disciplinas solas: "padel", "football", "soccer", "basketball"
- Modelos/líneas: "adizero", "vapor", "spotlight", "freak"

EN CASO DE DUDA → "rule": null

FORMATO — entrega SOLO esto:
{
  "category": "<NOMBRE_EXACTO>",
  "confidence": <0.0-1.0>,
  "rule": { "type": "any|all|exclude", "match": "startswith|contains", "keywords": ["kw"], "reason": "breve" }
}

Si no encaja: { "category": "SIN_CATEGORIA", "confidence": 0, "rule": null }

EXCLUDE — si el nombre NO es un producto (descuento, porcentaje, abono, promo):
- Siempre propón exclude: "10% en tu orden" → startswith "10%", "abono x" → contains "abono"`;
}

// ─────────────────────────────────────────
// CLAUDE — con prompt caching
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
  if (!found.length) { console.warn(`⚠️  Categoría "${categoryName}" no encontrada`); return null; }
  categIdCache[categoryName] = found[0].id;
  return found[0].id;
}

function extractJSON(text) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  let depth = 0, start = -1, results = [];
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i] === "{") { if (depth === 0) start = i; depth++; }
    else if (cleaned[i] === "}") {
      depth--;
      if (depth === 0 && start !== -1) { results.push(cleaned.slice(start, i + 1)); start = -1; }
    }
  }
  for (const r of results.reverse()) {
    try { const p = JSON.parse(r); if (p.category !== undefined) return p; } catch (e) {}
  }
  throw new Error("Sin JSON válido: " + text.slice(0, 120));
}

async function classifyWithAI(product) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "prompt-caching-2024-07-31"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      system: [
        {
          type: "text",
          text: buildSystemPrompt(),
          cache_control: { type: "ephemeral" }
        }
      ],
      messages: [{
        role: "user",
        content: "Nombre: " + product.name + "\nReferencia: " + (product.default_code || "sin referencia")
      }]
    })
  });

  if (!response.ok) throw new Error("Claude API " + response.status + ": " + await response.text());
  const data = await response.json();

  const cacheRead  = data.usage?.cache_read_input_tokens || 0;
  const cacheWrite = data.usage?.cache_creation_input_tokens || 0;
  if (cacheWrite > 0) console.log(`💾 Cache WRITE: ${cacheWrite} tokens`);
  if (cacheRead  > 0) console.log(`💾 Cache READ:  ${cacheRead} tokens (90% ahorro)`);

  return extractJSON(data.content[0].text);
}

// ─────────────────────────────────────────
// LOOP PRINCIPAL
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
    if (!batch.length) { console.log("🏁 Todos los productos procesados."); isRunning = false; return; }
    product = batch.find(p => !processedIds.has(p.id));
    if (!product) offset += 50;
  }

  const label = `[${product.id}] "${product.name}"`;
  stats.processed++;

  try {
    let finalCategory = null;

    // 1. Reglas aprendidas
    const learnedCategory = applyLearnedRules(product.name);
    if (learnedCategory) {
      finalCategory = learnedCategory;
      console.log(`🧠 ${label} → "${finalCategory}" (regla aprendida)`);
    }

    // 2a. Exclusión aprendida
    if (!finalCategory && applyExclusionRule(product.name)) {
      const id = await getCategId(uid, "INFORMACIÓN INSUFICIENTE");
      if (id) await odooCall("object", "execute_kw", [DB, uid, PASS, "product.template", "write", [[product.id], { categ_id: id }]]);
      console.log(`🚫 ${label} — excluido → INFORMACIÓN INSUFICIENTE`);
      stats.skipped++;
      processedIds.add(product.id);
      saveProcessed(processedIds);
      scheduleNext();
      return;
    }

    // 2b. Nombre insuficiente
    if (!finalCategory) {
      const wordCount = product.name.trim().split(/\s+/).filter(w => w.length > 1).length;
      if (wordCount < 3) {
        const id = await getCategId(uid, "INFORMACIÓN INSUFICIENTE");
        if (id) await odooCall("object", "execute_kw", [DB, uid, PASS, "product.template", "write", [[product.id], { categ_id: id }]]);
        console.log(`⚠️  ${label} — nombre insuficiente → INFORMACIÓN INSUFICIENTE`);
        stats.skipped++;
        processedIds.add(product.id);
        saveProcessed(processedIds);
        scheduleNext();
        return;
      }
    }

    // 3. Claude
    if (!finalCategory) {
      const result = await classifyWithAI(product);
      console.log(`🤖 ${label} → "${result.category}" (confianza: ${result.confidence})`);

      if (result.category !== "SIN_CATEGORIA" && result.confidence >= 0.75) {
        finalCategory = result.category;

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
          console.log(`${result.rule.type === "exclude" ? "🚫" : "💡"} Nueva regla [${result.rule.type}]: ${JSON.stringify(newRule.keywords)} → "${newRule.category}"`);
        }
      } else {
        console.log(`⏭️  ${label} omitido — confianza insuficiente`);
        stats.skipped++;

        // Exclusión automática para patrones obvios
        const name = product.name.trim();
        const autoPatterns = [
          { test: /^\d+%/, rule: { type: "exclude", match: "startswith", keywords: [name.match(/^\d+%/)?.[0]] } },
          { test: /^abono/i,     rule: { type: "exclude", match: "startswith", keywords: ["abono"] } },
          { test: /^descuento/i, rule: { type: "exclude", match: "startswith", keywords: ["descuento"] } },
        ];
        for (const { test, rule } of autoPatterns) {
          if (test.test(name) && rule.keywords[0] && !ruleAlreadyExists(rule)) {
            const newRule = { ...rule, category: "EXCLUIDO", reason: "Patrón automático — no es un producto", example: name, addedAt: new Date().toISOString() };
            learnedRules.push(newRule);
            saveRules(learnedRules);
            console.log(`🚫 Regla de exclusión automática: "${newRule.keywords[0]}"`);
            break;
          }
        }
      }
    }

    if (finalCategory) {
      const categId = await getCategId(uid, finalCategory);
      if (!categId) { console.warn(`⚠️  categ_id no encontrado para "${finalCategory}"`); stats.errors++; }
      else {
        await odooCall("object", "execute_kw", [DB, uid, PASS, "product.template", "write", [[product.id], { categ_id: categId }]]);
        console.log(`✅ ${label} → "${finalCategory}" (categ_id: ${categId})`);
        stats.categorized++;
      }
    }

  } catch (e) {
    console.error(`❌ ${label} — error:`, e.message);
    stats.errors++;
    appendErrorLog({
      at: new Date().toISOString(),
      type: e.message.includes("429") ? "RATE_LIMIT" : e.message.includes("Sin JSON") ? "PARSE_ERROR" : "ERROR",
      productId: product.id,
      productName: product.name.trim(),
      message: e.message.slice(0, 200)
    }).catch(() => {});
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
// ENDPOINTS
// ─────────────────────────────────────────

app.post("/start", (req, res) => {
  if (isRunning && !isPaused) return res.json({ message: "Ya está corriendo.", stats });
  if (isPaused) { isPaused = false; scheduleNext(); return res.json({ message: "Reanudado.", stats }); }
  isRunning = true;
  stats = { processed: 0, categorized: 0, errors: 0, skipped: 0, startedAt: new Date().toISOString() };
  processNext();
  res.json({ message: "Iniciado.", stats });
});

app.post("/pause", (req, res) => {
  if (!isRunning) return res.json({ message: "No está corriendo." });
  isPaused = true;
  if (currentTimer) clearTimeout(currentTimer);
  res.json({ message: "Pausado.", stats });
});

app.post("/stop", (req, res) => {
  isRunning = false; isPaused = false;
  if (currentTimer) clearTimeout(currentTimer);
  res.json({ message: "Detenido.", stats });
});

app.get("/status", (req, res) => {
  res.json({ isRunning, isPaused, totalProcessed: processedIds.size, sessionStats: stats });
});

app.post("/reset-processed", (req, res) => {
  isRunning = false;
  if (currentTimer) clearTimeout(currentTimer);
  processedIds.clear();
  saveProcessed(processedIds);
  res.json({ message: "Lista reseteada." });
});

app.post("/reprocess/:id", (req, res) => {
  const id = parseInt(req.params.id);
  if (processedIds.has(id)) { processedIds.delete(id); saveProcessed(processedIds); res.json({ message: `Producto ${id} removido.` }); }
  else res.json({ message: `Producto ${id} no estaba en la lista.` });
});

app.get("/claude-logs", (req, res) => res.json({ total: claudeLogs.length, logs: claudeLogs }));
app.get("/health", (req, res) => res.send("OK"));

// ─────────────────────────────────────────
// ARRANQUE
// ─────────────────────────────────────────

(async () => {
  processedIds = await loadProcessed();
  learnedRules = await loadRules();
  console.log(`📂 IDs procesados: ${processedIds.size}`);

  const PORT = process.env.CATEGORIZER_PORT || 3001;
  app.listen(PORT, () => {
    console.log(`🚀 Categorizer en puerto ${PORT}`);
    console.log(`   POST /pause  POST /stop  GET /status  POST /reset-processed  POST /reprocess/:id`);
  });

  isRunning = true;
  stats = { processed: 0, categorized: 0, errors: 0, skipped: 0, startedAt: new Date().toISOString() };
  console.log("▶️  Arrancando automáticamente...");
  processNext();
})();