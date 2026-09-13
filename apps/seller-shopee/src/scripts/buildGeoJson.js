const https = require("https");
const fs = require("fs");
const path = require("path");

const statesUrl =
  "https://github.com/giuliano-macedo/geodata-br-states/raw/refs/heads/main/geojson/br_states.json";
const municipiosUrl =
  "https://github.com/kelvins/municipios-brasileiros/raw/refs/heads/main/json/municipios.json";

// Ajuste automático: cria em src/public/json/Geo.json se o script estiver em src/scripts
const outputDir = path.join(__dirname, "..", "..", "public", "json");
const outputFile = path.join(outputDir, "Geo.json");
const UF_CODE_TO_UF = {
  11: "RO",
  12: "AC",
  13: "AM",
  14: "RR",
  15: "PA",
  16: "AP",
  17: "TO",
  21: "MA",
  22: "PI",
  23: "CE",
  24: "RN",
  25: "PB",
  26: "PE",
  27: "AL",
  28: "SE",
  29: "BA",
  31: "MG",
  32: "ES",
  33: "RJ",
  35: "SP",
  41: "PR",
  42: "SC",
  43: "RS",
  50: "MS",
  51: "MT",
  52: "GO",
  53: "DF",
};

function fetchText(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent": "DAVANTTI-geo-builder",
          Accept: "application/json,text/plain,*/*",
        },
      },
      (res) => {
        const code = res.statusCode || 0;

        // segue redirects do GitHub
        if ([301, 302, 303, 307, 308].includes(code)) {
          const loc = res.headers.location;
          if (!loc) return reject(new Error(`Redirect sem Location: ${url}`));
          if (redirectsLeft <= 0)
            return reject(new Error(`Redirect loop: ${url}`));

          const nextUrl = new URL(loc, url).toString();
          res.resume(); // descarta body
          return resolve(fetchText(nextUrl, redirectsLeft - 1));
        }

        if (code >= 400) {
          res.resume();
          return reject(new Error(`HTTP ${code} ao baixar ${url}`));
        }

        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      }
    );

    req.on("error", reject);
    req.end();
  });
}

async function fetchJson(url) {
  const text = await fetchText(url);

  const trimmed = String(text || "").trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    const preview = trimmed.slice(0, 200);
    throw new Error(`Resposta não-JSON de ${url}. Início: ${preview}`);
  }

  try {
    return JSON.parse(trimmed);
  } catch (e) {
    throw new Error(`Falha ao parsear JSON de ${url}: ${e.message}`);
  }
}

function normalizeCity(city) {
  return String(city || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  console.log("Baixando GeoJSON dos estados e JSON dos municípios...");
  const [statesGeoJson, municipios] = await Promise.all([
    fetchJson(statesUrl),
    fetchJson(municipiosUrl),
  ]);

  const municipiosArr = Array.isArray(municipios) ? municipios : [];
  console.log(`Total municípios lidos: ${municipiosArr.length}`);

  const cityPointsByUf = {};
  let totalPoints = 0;

  for (const mun of municipiosArr) {
    const uf =
      (mun.uf || mun.UF || "").toString().trim().toUpperCase() ||
      UF_CODE_TO_UF[Number(mun.codigo_uf)] ||
      "";
    if (!uf || uf.length !== 2) continue;
    const lat = Number(mun.latitude);
    const lng = Number(mun.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const city = (mun.nome || mun.name || "").toString().trim();
    if (!city) continue;

    const cityNorm = normalizeCity(city);

    if (!cityPointsByUf[uf]) cityPointsByUf[uf] = [];
    cityPointsByUf[uf].push({ city, cityNorm, lat, lng });
    totalPoints += 1;
  }

  // Ordenar cidades por nome
  for (const uf of Object.keys(cityPointsByUf)) {
    cityPointsByUf[uf].sort((a, b) => a.city.localeCompare(b.city, "pt-BR"));
  }

  const result = {
    meta: {
      generatedAt: new Date().toISOString(),
      sources: {
        statesGeoJsonUrl: statesUrl,
        municipiosUrl: municipiosUrl,
      },
    },
    brStatesGeoJson: statesGeoJson, // sem alterações
    cityPointsByUf,
  };

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(result));

  console.log(`Total pontos gerados: ${totalPoints}`);
  console.log(`Número de UFs: ${Object.keys(cityPointsByUf).length}`);
  console.log(`Arquivo gerado em: ${outputFile}`);
}

main().catch((e) => {
  console.error("Erro:", e.message);
  process.exit(1);
});
