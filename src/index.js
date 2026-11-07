// 4 UHA Render MCP — konektor za Claude koji generira rendere preko OpenAI (gpt-image) i xAI (Grok Imagine).
// Cloudflare Worker. Tajne: OPENAI_API_KEY, XAI_API_KEY, ACCESS_TOKEN. R2 bucket: RENDERS.
//
// Rute:
//   POST /mcp/<ACCESS_TOKEN>      MCP (Streamable HTTP, JSON odgovori) — ovo se upisuje u Claude kao konektor
//   GET  /upload/<ACCESS_TOKEN>   stranica za upload podloga (screenshot iz ArchiCAD-a, skica…)
//   POST /upload/<ACCESS_TOKEN>   prijem uploada
//   GET  /f/<kljuc>               preuzimanje uploada/rendera (nasumični, nepogodivi ključevi)

import { Buffer } from "node:buffer";

const SERVER_INFO = { name: "4uha-render", version: "1.0.1" };
const MAX_INLINE_B64 = 1_400_000; // veće slike Claudeu šaljemo samo kao link
const SIZES = { landscape: "1536x1024", portrait: "1024x1536", square: "1024x1024" };
const XAI_ASPECT = { landscape: "3:2", portrait: "2:3", square: "1:1" };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const base = `${url.protocol}//${url.host}`;

    try {
      if (parts[0] === "f" && parts.length > 1 && request.method === "GET") {
        return serveFile(env, parts.slice(1).join("/"));
      }
      if (parts[0] === "upload") {
        if (!checkToken(env, parts[1])) return new Response("Neovlašteno", { status: 401 });
        if (request.method === "GET") return html(uploadPage());
        if (request.method === "POST") return handleUpload(request, env, base);
      }
      if (parts[0] === "mcp") {
        if (parts.length !== 2) return new Response("Not found", { status: 404 });
        if (!checkToken(env, parts[1])) return new Response("Unauthorized", { status: 401 });
        if (request.method === "POST") return handleMcp(request, env, base, parts[1]);
        if (request.method === "DELETE") return new Response(null, { status: 204 });
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
      }
      // Samo korijen vraća 200. Sve ostalo (npr. /.well-known/oauth-*) mora biti 404,
      // inače Claude misli da server traži OAuth prijavu i spajanje konektora pada.
      if (parts.length === 0) return new Response("4 UHA Render MCP", { status: 200 });
      return new Response("Not found", { status: 404 });
    } catch (e) {
      return new Response(`Greška: ${e.message}`, { status: 500 });
    }
  },
};

// ---------- pomoćne ----------

function checkToken(env, token) {
  if (!env.ACCESS_TOKEN || !token) return false;
  const a = new TextEncoder().encode(env.ACCESS_TOKEN);
  const b = new TextEncoder().encode(token);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function html(body, status = 200) {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}

function slug(s) {
  return (s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[đĐ]/g, "d").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

function extFromType(t) {
  if (!t) return "bin";
  if (t.includes("png")) return "png";
  if (t.includes("jpeg") || t.includes("jpg")) return "jpg";
  if (t.includes("webp")) return "webp";
  return "bin";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

async function serveFile(env, key) {
  if (!/^(uploads|renders)\//.test(key)) return new Response("Not found", { status: 404 });
  const obj = await env.RENDERS.get(key);
  if (!obj) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("Cache-Control", "private, max-age=3600");
  return new Response(obj.body, { headers });
}

// ---------- upload ----------

function uploadPage(result = "") {
  return `<!doctype html><html lang="hr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>4 UHA Render – upload podloge</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#222}
h1{font-size:20px}input,button{font-size:16px;margin:6px 0}button{padding:8px 16px;cursor:pointer}
.ok{background:#eef7ee;border:1px solid #9c9;padding:12px;margin-top:16px}code{background:#f3f3f3;padding:2px 4px}</style></head>
<body><h1>4 UHA Render — upload podloge</h1>
<p>Screenshot iz ArchiCAD-a, skica ili fotografija postojećeg stanja (PNG/JPG/WEBP, do 20 MB).</p>
<form method="post" enctype="multipart/form-data">
<div><label>Projekt / oznaka (npr. A26-009):<br><input name="label" size="30"></label></div>
<div><input type="file" name="file" accept="image/png,image/jpeg,image/webp" multiple required></div>
<button type="submit">Uploadaj</button></form>${result}
<p style="margin-top:24px;color:#666">Nakon uploada u Claudeu samo napiši npr. „render iz zadnjeg uploada, večernje svjetlo”.</p>
</body></html>`;
}

async function handleUpload(request, env, base) {
  const form = await request.formData();
  const label = slug(form.get("label"));
  const files = form.getAll("file").filter((f) => f && typeof f === "object" && f.size > 0);
  if (!files.length) return html(uploadPage('<div class="ok">Nije odabrana nijedna datoteka.</div>'), 400);
  const rows = [];
  for (const f of files) {
    if (f.size > 20 * 1024 * 1024) { rows.push(`${escapeHtml(f.name)}: prevelika datoteka`); continue; }
    const id = crypto.randomUUID().slice(0, 13);
    const key = `uploads/${id}.${extFromType(f.type)}`;
    await env.RENDERS.put(key, await f.arrayBuffer(), {
      httpMetadata: { contentType: f.type || "application/octet-stream" },
      customMetadata: { name: f.name, label, uploaded: new Date().toISOString() },
    });
    rows.push(`<code>${id}</code> — ${escapeHtml(f.name)} — <a href="${base}/f/${key}" target="_blank">pogledaj</a>`);
  }
  return html(uploadPage(`<div class="ok"><b>Spremljeno:</b><br>${rows.join("<br>")}</div>`));
}

async function listUploads(env, limit) {
  const all = [];
  let cursor;
  do {
    const res = await env.RENDERS.list({ prefix: "uploads/", cursor, include: ["customMetadata"] });
    all.push(...res.objects);
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor && all.length < 2000);
  all.sort((a, b) => b.uploaded - a.uploaded);
  return all.slice(0, limit);
}

async function resolveReference(env, ref) {
  ref = String(ref).trim();
  if (/^https?:\/\//.test(ref)) {
    const r = await fetch(ref);
    if (!r.ok) throw new Error(`Ne mogu dohvatiti referencu ${ref} (${r.status})`);
    const type = r.headers.get("content-type") || "image/png";
    return { bytes: new Uint8Array(await r.arrayBuffer()), type, name: "ref." + extFromType(type) };
  }
  let key = ref.startsWith("uploads/") ? ref : null;
  if (!key) {
    const res = await env.RENDERS.list({ prefix: `uploads/${ref}` });
    if (!res.objects.length) throw new Error(`Upload "${ref}" ne postoji. Pozovi list_uploads za popis.`);
    key = res.objects[0].key;
  }
  const obj = await env.RENDERS.get(key);
  if (!obj) throw new Error(`Upload "${ref}" ne postoji.`);
  const type = obj.httpMetadata?.contentType || "image/png";
  return { bytes: new Uint8Array(await obj.arrayBuffer()), type, name: key.split("/").pop() };
}

// ---------- providers ----------

async function openaiRender(env, { prompt, refs, aspect, quality, n }) {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY nije postavljen u Cloudflareu.");
  const model = env.OPENAI_IMAGE_MODEL || "gpt-image-2";
  const common = { size: SIZES[aspect], quality, n, output_format: "jpeg", output_compression: 88 };
  let res;
  if (refs.length) {
    const fd = new FormData();
    fd.append("model", model);
    fd.append("prompt", prompt);
    for (const [k, v] of Object.entries(common)) fd.append(k, String(v));
    for (const r of refs) fd.append("image[]", new Blob([r.bytes], { type: r.type }), r.name);
    res = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST", headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` }, body: fd,
    });
  } else {
    res = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt, ...common }),
    });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${data?.error?.message || JSON.stringify(data).slice(0, 300)}`);
  return Promise.all((data.data || []).map((d) => toImage(d, "image/jpeg")));
}

async function xaiRender(env, { prompt, refs, aspect, n }) {
  if (!env.XAI_API_KEY) throw new Error("XAI_API_KEY nije postavljen u Cloudflareu.");
  const model = env.XAI_IMAGE_MODEL || "grok-imagine-image-2.0";
  const endpoint = refs.length ? "edits" : "generations";
  const body = { model, prompt, n, response_format: "b64_json" };
  if (refs.length) {
    // xAI dokumentira jednu izvornu sliku kao { url, type: "image_url" }; šaljemo prvu referencu kao data URI.
    const r = refs[0];
    body.image = { url: `data:${r.type};base64,${Buffer.from(r.bytes).toString("base64")}`, type: "image_url" };
  }
  const optional = { aspect_ratio: XAI_ASPECT[aspect], ...(env.XAI_RESOLUTION ? { resolution: env.XAI_RESOLUTION } : {}) };

  const call = (payload) => fetch(`https://api.x.ai/v1/images/${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.XAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  let res = await call({ ...body, ...optional });
  if (res.status === 400) res = await call(body); // ako API ne prihvaća opcionalna polja, pokušaj bez njih
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`xAI ${res.status}: ${data?.error?.message || data?.error || JSON.stringify(data).slice(0, 300)}`);
  const note = refs.length > 1 ? "Grok je koristio samo prvu referentnu sliku." : null;
  const imgs = await Promise.all((data.data || []).map((d) => toImage(d, "image/jpeg")));
  return note ? imgs.map((i) => ({ ...i, note })) : imgs;
}

async function toImage(d, fallbackType) {
  if (d.b64_json) return { b64: d.b64_json, type: sniffType(d.b64_json) || fallbackType };
  if (d.url) {
    const r = await fetch(d.url);
    const buf = new Uint8Array(await r.arrayBuffer());
    const b64 = Buffer.from(buf).toString("base64");
    return { b64, type: r.headers.get("content-type") || sniffType(b64) || fallbackType };
  }
  throw new Error("Odgovor bez slike.");
}

function sniffType(b64) {
  if (b64.startsWith("iVBOR")) return "image/png";
  if (b64.startsWith("/9j/")) return "image/jpeg";
  if (b64.startsWith("UklGR")) return "image/webp";
  return null;
}

// ---------- alati ----------

const TOOLS = [
  {
    name: "render_image",
    description:
      "Generira arhitektonski render ili vizualizaciju preko OpenAI (gpt-image) i/ili xAI (Grok Imagine). " +
      "Ako su zadane reference (ID-evi uploadanih podloga ili https URL-ovi), render se radi IZ podloge i treba zadržati geometriju " +
      "(broj etaža, krov, otvori, proporcije) — u promptu to izričito traži. Bez referenci generira iz teksta. " +
      "Vraća slike i trajne linkove za preuzimanje. Generiranje traje 20–90 s i naplaćuje se po slici.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Detaljan opis rendera: materijali, svjetlo, doba dana, okoliš, kadar, stil. Na engleskom daje najbolje rezultate." },
        provider: { type: "string", enum: ["openai", "xai", "both"], default: "openai", description: "Koji servis; zadano OpenAI. 'both' za usporedbu (preskače servis bez API ključa)." },
        reference_ids: { type: "array", items: { type: "string" }, description: "ID-evi uploada (iz list_uploads) ili https URL-ovi podloga. OpenAI prima više, Grok koristi prvu." },
        aspect: { type: "string", enum: ["landscape", "portrait", "square"], default: "landscape" },
        quality: { type: "string", enum: ["low", "medium", "high"], default: "high", description: "Samo OpenAI. 'low' za brze skice." },
        n: { type: "integer", minimum: 1, maximum: 4, default: 1, description: "Broj slika po servisu." },
        label: { type: "string", description: "Oznaka projekta za naziv datoteke, npr. A26-009." },
      },
      required: ["prompt"],
    },
  },
  {
    name: "list_uploads",
    description: "Popis zadnjih uploadanih podloga (screenshotovi, skice) s ID-evima za render_image, i link na stranicu za upload.",
    inputSchema: { type: "object", properties: { limit: { type: "integer", minimum: 1, maximum: 50, default: 10 } } },
  },
];

async function callTool(name, args, env, base, token) {
  if (name === "list_uploads") {
    const items = await listUploads(env, args.limit || 10);
    const lines = items.map((o) => {
      const id = o.key.replace(/^uploads\//, "").replace(/\.[^.]+$/, "");
      const m = o.customMetadata || {};
      return `- ${id} | ${m.name || ""} | ${m.label || "-"} | ${o.uploaded.toISOString().slice(0, 16).replace("T", " ")} UTC | ${base}/f/${o.key}`;
    });
    return {
      content: [{
        type: "text",
        text: `Stranica za upload: ${base}/upload/${token}\n\n` +
          (lines.length ? `Zadnji uploadi (najnoviji prvi): id | datoteka | oznaka | vrijeme | link\n${lines.join("\n")}` : "Još nema uploada."),
      }],
    };
  }

  if (name === "render_image") {
    const prompt = String(args.prompt || "").trim();
    if (!prompt) throw new Error("Prompt je obavezan.");
    const provider = args.provider || env.DEFAULT_PROVIDER || "openai";
    const aspect = SIZES[args.aspect] ? args.aspect : "landscape";
    const quality = ["low", "medium", "high"].includes(args.quality) ? args.quality : "high";
    const n = Math.min(Math.max(parseInt(args.n || 1, 10) || 1, 1), 4);
    const refs = await Promise.all((args.reference_ids || []).slice(0, 8).map((r) => resolveReference(env, r)));
    const opts = { prompt, refs, aspect, quality, n };

    const jobs = [];
    const skipped = [];
    const want = (p, key) => provider === p || (provider === "both" && (env[key] || (skipped.push(p), false)));
    if (want("openai", "OPENAI_API_KEY")) jobs.push(["OpenAI", openaiRender(env, opts)]);
    if (want("xai", "XAI_API_KEY")) jobs.push(["Grok", xaiRender(env, opts)]);
    if (!jobs.length) throw new Error("Nijedan servis nema postavljen API ključ.");
    const settled = await Promise.allSettled(jobs.map((j) => j[1]));

    const day = new Date().toISOString().slice(0, 10);
    const label = slug(args.label) || "render";
    const content = [];
    const summary = [];
    for (let i = 0; i < jobs.length; i++) {
      const [who] = jobs[i];
      const s = settled[i];
      if (s.status === "rejected") { summary.push(`${who}: GREŠKA — ${s.reason?.message || s.reason}`); continue; }
      for (const img of s.value) {
        const key = `renders/${day}/${label}_${who.toLowerCase()}_${crypto.randomUUID().slice(0, 8)}.${extFromType(img.type)}`;
        await env.RENDERS.put(key, Buffer.from(img.b64, "base64"), {
          httpMetadata: { contentType: img.type },
          customMetadata: { provider: who, prompt: prompt.slice(0, 1500), refs: (args.reference_ids || []).join(",") },
        });
        summary.push(`${who}: ${base}/f/${key}${img.note ? ` (${img.note})` : ""}`);
        if (img.b64.length <= MAX_INLINE_B64) {
          content.push({ type: "text", text: `${who}:` });
          content.push({ type: "image", data: img.b64, mimeType: img.type });
        }
      }
    }
    if (skipped.length) summary.push(`Preskočeno (nema API ključa): ${skipped.join(", ")}`);
    content.unshift({ type: "text", text: `Rezultati (linkovi za preuzimanje):\n${summary.join("\n")}` });
    const allFailed = settled.every((s) => s.status === "rejected");
    return { content, isError: allFailed };
  }

  throw new Error(`Nepoznat alat: ${name}`);
}

// ---------- MCP (JSON-RPC preko HTTP-a) ----------

async function handleMcp(request, env, base, token) {
  let msg;
  try { msg = await request.json(); } catch { return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400); }
  if (Array.isArray(msg)) {
    const out = (await Promise.all(msg.map((m) => handleRpc(m, env, base, token)))).filter(Boolean);
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const out = await handleRpc(msg, env, base, token);
  return out ? json(out) : new Response(null, { status: 202 });
}

async function handleRpc(msg, env, base, token) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  if (isNotification) return null;
  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: params?.protocolVersion || "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "4 UHA alat za rendere. Za render iz podloge: korisnik uploada sliku na stranicu za upload (link daje list_uploads), " +
          "zatim render_image s reference_ids. Uvijek usporedi rezultat s podlogom i upozori na odstupanja geometrije.",
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "tools/call":
      try {
        return ok(await callTool(params?.name, params?.arguments || {}, env, base, token));
      } catch (e) {
        return ok({ content: [{ type: "text", text: `Greška: ${e.message}` }], isError: true });
      }
    case "resources/list":
      return ok({ resources: [] });
    case "prompts/list":
      return ok({ prompts: [] });
    default:
      return err(-32601, `Method not found: ${method}`);
  }
}
