// Lee la base de Notion, asigna cada lugar a un país y escribe data.json.
// Solo se publican conteos por país y coordenadas redondeadas: sin nombres, direcciones ni fechas.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import * as turf from "@turf/turf";
import { feature } from "topojson-client";

const require = createRequire(import.meta.url);

// ---------- Configuración (se puede cambiar desde el workflow) ----------
const NOTION_VERSION = "2022-06-28";
const PROP_LUGAR = process.env.NOTION_PLACE_PROP || "Lugar";
const PROP_REALIZADO = process.env.NOTION_DONE_PROP || "Realizado";
const SOLO_REALIZADOS = (process.env.SOLO_REALIZADOS || "false") === "true";
const DECIMALES = Number(process.env.DECIMALES || 1); // 1 decimal ≈ 11 km
const DISTANCIA_MAX_KM = 50; // para puntos en la costa que caen "fuera" del polígono simplificado

// ---------- Países (Natural Earth vía world-atlas, 50m) ----------
function cargarPaises() {
  const topoPath = require.resolve("world-atlas/countries-50m.json");
  const topo = JSON.parse(fs.readFileSync(topoPath, "utf8"));
  return feature(topo, topo.objects.countries).features.map((f) => ({
    nombre: f.properties.name,
    geometria: f,
    bbox: turf.bbox(f),
  }));
}

function dentroDeBbox([lon, lat], [minX, minY, maxX, maxY]) {
  return lon >= minX && lon <= maxX && lat >= minY && lat <= maxY;
}

export function paisDe(lat, lon, paises) {
  const punto = turf.point([lon, lat]);
  for (const p of paises) {
    if (!dentroDeBbox([lon, lat], p.bbox)) continue;
    if (turf.booleanPointInPolygon(punto, p.geometria)) return p.nombre;
  }
  // Respaldo: país más cercano (costas, islas pequeñas, mapas simplificados)
  let mejor = null;
  let mejorDist = Infinity;
  for (const p of paises) {
    const [minX, minY, maxX, maxY] = p.bbox;
    // descarte rápido: bbox ampliada ~1° (≈111 km)
    if (lon < minX - 1 || lon > maxX + 1 || lat < minY - 1 || lat > maxY + 1) continue;
    const d = distanciaAPais(punto, p.geometria);
    if (d < mejorDist) {
      mejorDist = d;
      mejor = p.nombre;
    }
  }
  return mejorDist <= DISTANCIA_MAX_KM ? mejor : null;
}

function distanciaAPais(punto, geom) {
  const lineas = turf.polygonToLine(geom);
  const colecciones = lineas.type === "FeatureCollection" ? lineas.features : [lineas];
  let min = Infinity;
  for (const l of colecciones) {
    const partes = l.geometry.type === "MultiLineString"
      ? l.geometry.coordinates.map((c) => turf.lineString(c))
      : [l];
    for (const parte of partes) {
      const cercano = turf.nearestPointOnLine(parte, punto, { units: "kilometers" });
      if (cercano.properties.dist < min) min = cercano.properties.dist;
    }
  }
  return min;
}

// ---------- Procesamiento (separado para poder probarlo sin Notion) ----------
export function procesar(lugares, paises) {
  const vistos = new Set();
  const paisesOut = {};
  const puntos = [];
  let sinPais = 0;
  let duplicados = 0;

  for (const { lat, lon } of lugares) {
    const clave = `${lat.toFixed(4)},${lon.toFixed(4)}`;
    if (vistos.has(clave)) {
      duplicados++;
      continue; // mismo sitio repetido en varias filas: cuenta una sola vez
    }
    vistos.add(clave);

    const pais = paisDe(lat, lon, paises);
    if (!pais) {
      sinPais++;
      continue;
    }
    paisesOut[pais] = (paisesOut[pais] || 0) + 1;
    puntos.push([Number(lat.toFixed(DECIMALES)), Number(lon.toFixed(DECIMALES)), pais]);
  }

  return {
    data: {
      updated: new Date().toISOString().slice(0, 10),
      countries: paisesOut,
      points: puntos,
    },
    resumen: { lugares: vistos.size - sinPais, paises: Object.keys(paisesOut).length, sinPais, duplicados },
  };
}

// ---------- Notion ----------
async function leerNotion(token, dbId) {
  const lugares = [];
  let cursor;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    if (SOLO_REALIZADOS) body.filter = { property: PROP_REALIZADO, checkbox: { equals: true } };

    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Notion respondió ${res.status}: ${txt.slice(0, 300)}`);
    }
    const json = await res.json();
    for (const fila of json.results) {
      const lugar = fila.properties?.[PROP_LUGAR]?.place;
      if (lugar && typeof lugar.lat === "number" && typeof lugar.lon === "number") {
        lugares.push({ lat: lugar.lat, lon: lugar.lon });
      }
    }
    cursor = json.has_more ? json.next_cursor : undefined;
  } while (cursor);
  return lugares;
}

// ---------- Ejecución ----------
async function main() {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_DB_ID;
  if (!token || !dbId) throw new Error("Faltan los secretos NOTION_TOKEN y/o NOTION_DB_ID.");

  const paises = cargarPaises();
  const lugares = await leerNotion(token, dbId);
  const { data, resumen } = procesar(lugares, paises);

  const salida = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data.json");
  fs.writeFileSync(salida, JSON.stringify(data));

  console.log(
    `Filas con lugar: ${lugares.length} | únicos: ${resumen.lugares} | países: ${resumen.paises} | ` +
      `repetidos: ${resumen.duplicados} | sin país: ${resumen.sinPais}`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
