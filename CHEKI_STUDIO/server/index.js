import "dotenv/config";
import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import { TikTokLiveClient, EventType, GiftStreakTracker } from "piratetok-live-js";
import { load } from "cheerio";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createClient } from "@supabase/supabase-js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "data");
const studiosDir = path.join(dataDir, "studios");
const giftCatalogFile = path.join(dataDir, "tiktok-gifts.json");
fs.mkdirSync(studiosDir, { recursive: true });

// 永続データはSupabaseへ保存する。秘密鍵はサーバー環境変数だけに置く。
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "cheki-images";
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を環境変数に設定してください。");
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const app = express();
app.use(cors());
app.use((req, res, next) => { res.setHeader("Referrer-Policy", "no-referrer"); next(); });
app.use(express.json({ limit: "15mb" }));

const studios = new Map();
const clients = new Map();
const randomToken = () => crypto.randomBytes(32).toString("base64url");
const safeId = value => /^[a-f0-9]{32}$/.test(String(value || ""));
const studioDir = id => path.join(studiosDir, id);
const studioFile = id => path.join(studioDir(id), "studio.json");

function makeStudio(row, chekis = []) {
  return {
    id: row.id,
    adminKey: row.admin_key,
    viewKey: row.view_key,
    chekis,
    settings: {
      username: String(row.settings?.username || "").trim().replace(/^@/, ""),
      giftMode: row.settings?.giftMode === "specific" ? "specific" : "all",
      giftQuery: String(row.settings?.giftQuery || "").trim()
    },
    state: "disconnected", lastError: "", connection: null, connecting: false,
    manualDisconnect: false, connectionToken: 0, reconnectTimer: null,
    observedGifts: new Map()
  };
}
async function persistStudio(studio) {
  const { error } = await supabase.from("cheki_studios").upsert({
    id: studio.id,
    admin_key: studio.adminKey,
    view_key: studio.viewKey,
    settings: studio.settings
  }, { onConflict: "id" });
  if (error) throw error;
}
function publicImageUrl(imagePath) {
  return supabase.storage.from(STORAGE_BUCKET).getPublicUrl(imagePath).data.publicUrl;
}
function getStudio(id) { return studios.get(id) || null; }

async function loadStudioRows() {
  const { data: studioRows, error: studioError } = await supabase
    .from("cheki_studios").select("id,admin_key,view_key,settings");
  if (studioError) throw studioError;
  const { data: chekiRows, error: chekiError } = await supabase
    .from("cheki_items").select("studio_id,id,name,image_path,created_at").order("created_at", { ascending: true });
  if (chekiError) throw chekiError;
  const byStudio = new Map();
  for (const row of (chekiRows || [])) {
    const list = byStudio.get(row.studio_id) || [];
    list.push({ id: row.id, name: row.name, image: publicImageUrl(row.image_path), createdAt: Number(row.created_at) || Date.now(), imagePath: row.image_path });
    byStudio.set(row.studio_id, list);
  }
  studios.clear();
  for (const row of (studioRows || [])) studios.set(row.id, makeStudio(row, byStudio.get(row.id) || []));
  console.log(`Supabaseからスタジオ${studios.size}件、チェキ${(chekiRows || []).length}枚を読み込みました。`);
}

// 旧バージョンの data/studios が残っている場合だけ、初回起動時にSupabaseへ移行する。
async function migrateLocalStudios() {
  if (!fs.existsSync(studiosDir)) return;
  for (const entry of fs.readdirSync(studiosDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !safeId(entry.name)) continue;
    const file = path.join(studiosDir, entry.name, "studio.json");
    if (!fs.existsSync(file)) continue;
    try {
      const old = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!old.adminKey || !old.viewKey) continue;
      const row = { id: entry.name, adminKey: old.adminKey, viewKey: old.viewKey, settings: old.settings || { username: "", giftMode: "all", giftQuery: "" } };
      await persistStudio({ ...row, id: row.id, adminKey: row.adminKey, viewKey: row.viewKey, settings: row.settings });
      for (const item of (Array.isArray(old.chekis) ? old.chekis : [])) {
        if (!item?.id || typeof item.image !== "string" || !item.image.startsWith("data:image/png;base64,")) continue;
        const imagePath = `${entry.name}/${String(item.id).replace(/[^a-zA-Z0-9_-]/g, "_")}.png`;
        const bytes = Buffer.from(item.image.slice("data:image/png;base64,".length), "base64");
        const { error: uploadError } = await supabase.storage.from(STORAGE_BUCKET).upload(imagePath, bytes, { contentType: "image/png", upsert: true });
        if (uploadError) throw uploadError;
        const { error: rowError } = await supabase.from("cheki_items").upsert({ studio_id: entry.name, id: String(item.id), name: String(item.name || "チェキ"), image_path: imagePath, created_at: Number(item.createdAt) || Date.now() }, { onConflict: "studio_id,id" });
        if (rowError) throw rowError;
      }
      console.log(`旧データ移行: ${entry.name}`);
    } catch (error) {
      console.error(`旧データ移行失敗 (${entry.name}):`, error?.message || error);
    }
  }
}

async function uploadCheki(studioId, chekiId, dataUrl) {
  const prefix = "data:image/png;base64,";
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(prefix)) throw new Error("PNG画像データが正しくありません。");
  const bytes = Buffer.from(dataUrl.slice(prefix.length), "base64");
  if (!bytes.length) throw new Error("画像データが空です。");
  if (bytes.length > 10 * 1024 * 1024) throw new Error("画像サイズは10MB以下にしてください。");
  const imagePath = `${studioId}/${String(chekiId).replace(/[^a-zA-Z0-9_-]/g, "_")}.png`;
  const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(imagePath, bytes, {
    contentType: "image/png", upsert: true, cacheControl: "31536000"
  });
  if (error) throw error;
  return imagePath;
}


// Shared public Japan gift catalog (no user credentials / paid API).
let cachedGiftCatalog = [];
let giftCatalogUpdatedAt = null;
let giftCatalogError = "";
try {
  const saved = JSON.parse(fs.readFileSync(giftCatalogFile, "utf8"));
  cachedGiftCatalog = Array.isArray(saved.gifts) ? saved.gifts : [];
  giftCatalogUpdatedAt = saved.updatedAt || null;
} catch {}
function normalizeGift(item) {
  if (!item || typeof item !== "object") return null;
  const id = String(item.id ?? item.gift_id ?? item.giftId ?? "").trim();
  const name = String(item.name ?? item.gift_name ?? item.giftName ?? "").trim();
  if (!id && !name) return null;
  const rawCost = item.diamond_count ?? item.diamondCount ?? item.cost ?? item.diamondCost ?? item.giftDetails?.diamondCount;
  const cost = rawCost === null || rawCost === undefined || rawCost === "" ? null : Number(rawCost);
  const candidates = [item.image?.url_list?.[0], item.image?.url, item.icon?.url_list?.[0], item.icon?.url, item.image_url, item.icon_url, item.imageUrl, item.iconUrl];
  return { id, name: name || `ギフト ${id}`, coinCount: Number.isFinite(cost) ? cost : null, imageUrl: String(candidates.find(v => typeof v === "string" && /^https?:\/\//i.test(v)) || "") };
}
function normalizeName(v) { return String(v || "").normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/g, " "); }
async function fetchGiftCatalog() {
  try {
    const response = await fetch("https://streamtoearn.io/gifts?region=JP", { headers: { "User-Agent": "Mozilla/5.0 CHEKI-Studio/1.0", Accept: "text/html,application/xhtml+xml" }, signal: AbortSignal.timeout(25000) });
    if (!response.ok) throw new Error(`公開ギフトカタログの取得に失敗しました (HTTP ${response.status})`);
    const html = await response.text();
    const $ = load(html);
    const gifts = [];
    $('img[alt*="TikTok gift"], img[alt*="tiktok gift"]').each((_i, img) => {
      const node = $(img);
      const name = String(node.attr("alt") || "").replace(/\s+TikTok gift\s*$/i, "").trim();
      if (!name) return;
      let card = node, text = "";
      for (let d = 0; d < 7 && card.length; d++, card = card.parent()) {
        const t = card.text().replace(/\s+/g, " ").trim();
        if (t.toLowerCase().includes(name.toLowerCase()) && t.length < 500) { text = t; if (/\d/.test(t.replace(name, ""))) break; }
      }
      const match = text.replace(name, " ").match(/(?:^|\D)(\d[\d,]*)/);
      const cost = match ? Number(match[1].replace(/,/g, "")) : null;
      const candidates = [node.attr("src"), node.attr("data-src"), node.attr("data-lazy-src"), node.attr("data-original")];
      const srcset = node.attr("srcset") || "";
      if (srcset) candidates.unshift(srcset.split(",")[0]?.trim().split(/\s+/)[0]);
      const imageUrl = String(candidates.find(v => /^https?:\/\//i.test(v || "")) || "");
      gifts.push({ id: "", name, coinCount: Number.isFinite(cost) ? cost : null, imageUrl });
    });
    if (!gifts.length) throw new Error("公開カタログからギフトを読み取れませんでした。");
    try {
      const source = await (await fetch("https://raw.githubusercontent.com/antiops/tiktok-trending-data/main/live-gift-details.json", { signal: AbortSignal.timeout(20000) })).json();
      const rows = Array.isArray(source) ? source : Array.isArray(source?.gifts) ? source.gifts : [];
      const byNameCost = new Map();
      for (const raw of rows) { const g = normalizeGift(raw); if (g) byNameCost.set(`${normalizeName(g.name)}|${g.coinCount ?? ""}`, g); }
      for (const g of gifts) { const found = byNameCost.get(`${normalizeName(g.name)}|${g.coinCount ?? ""}`); if (found) g.id = found.id; }
    } catch (e) { console.warn("ギフトIDの照合は一部省略:", e?.message || e); }
    const merged = new Map();
    for (const g of [...cachedGiftCatalog, ...gifts]) merged.set(g.id || `${normalizeName(g.name)}|${g.coinCount ?? ""}`, { ...(merged.get(g.id || `${normalizeName(g.name)}|${g.coinCount ?? ""}`) || {}), ...g });
    cachedGiftCatalog = [...merged.values()].sort((a,b) => (a.coinCount ?? Number.MAX_SAFE_INTEGER) - (b.coinCount ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name,"ja"));
    giftCatalogUpdatedAt = new Date().toISOString(); giftCatalogError = "";
    fs.writeFileSync(giftCatalogFile, JSON.stringify({ updatedAt: giftCatalogUpdatedAt, gifts: cachedGiftCatalog }, null, 2));
    console.log(`日本向け公開ギフトカタログ: ${cachedGiftCatalog.length}件`);
    return { ok: true, count: cachedGiftCatalog.length };
  } catch (e) { giftCatalogError = String(e?.message || e); console.warn("ギフト一覧取得失敗:", giftCatalogError); return { ok: false, error: giftCatalogError, count: cachedGiftCatalog.length }; }
}

const server = createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });
function broadcast(studioId, payload) {
  const msg = JSON.stringify(payload);
  for (const socket of wss.clients) if (socket.readyState === 1 && socket.studioId === studioId) socket.send(msg);
}
wss.on("connection", (socket, req) => {
  try {
    const url = new URL(req.url, "http://localhost");
    const id = url.searchParams.get("studio");
    const key = url.searchParams.get("view");
    const studio = getStudio(id);
    if (!studio || !key || key !== studio.viewKey) { socket.close(1008, "Invalid studio view key"); return; }
    socket.studioId = id;
  } catch { socket.close(1008, "Invalid request"); }
});

function requireStudio(req, res, next) {
  const studio = getStudio(req.params.id);
  if (!studio) return res.status(404).json({ error: "スタジオが見つかりません。URLを確認してください。" });
  const key = String(req.headers["x-studio-admin-key"] || "");
  if (!key || key !== studio.adminKey) return res.status(403).json({ error: "管理用URLが正しくありません。" });
  req.studio = studio; next();
}
app.post("/api/studios", async (_req, res) => {
  const id = crypto.randomBytes(16).toString("hex");
  const studio = { id, adminKey: randomToken(), viewKey: randomToken(), chekis: [], settings: { username: "", giftMode: "all", giftQuery: "" }, state: "disconnected", lastError: "", connection: null, connecting: false, manualDisconnect: false, connectionToken: 0, reconnectTimer: null, observedGifts: new Map() };
  try {
    await persistStudio(studio);
    studios.set(id, studio);
    res.status(201).json({ id, adminKey: studio.adminKey, viewKey: studio.viewKey, adminUrl: `/studio/${id}/admin?key=${studio.adminKey}`, overlayUrl: `/studio/${id}/overlay?view=${studio.viewKey}` });
  } catch (error) {
    console.error("スタジオ保存失敗:", error?.message || error);
    res.status(500).json({ error: "スタジオをデータベースに保存できませんでした。Supabaseの設定を確認してください。" });
  }
});

app.get("/api/studios/:id/status", requireStudio, (req, res) => {
  const s = req.studio;
  const gifts = new Map();
  for (const g of [...cachedGiftCatalog, ...s.observedGifts.values()]) gifts.set(g.id || g.name, { ...(gifts.get(g.id || g.name) || {}), ...g });
  res.set("Cache-Control", "no-store").json({ username: s.settings.username, giftMode: s.settings.giftMode, giftQuery: s.settings.giftQuery, connected: s.state === "connected", connecting: s.state === "connecting", state: s.state, lastError: s.lastError, availableGifts: [...gifts.values()].sort((a,b) => (a.coinCount ?? Number.MAX_SAFE_INTEGER) - (b.coinCount ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name,"ja")), giftCatalogUpdatedAt, giftCatalogError });
});
app.get("/api/studios/:id/chekis", requireStudio, async (req, res) => {
  try {
    const { data, error } = await supabase.from("cheki_items")
      .select("id,name,image_path,created_at")
      .eq("studio_id", req.studio.id)
      .order("created_at", { ascending: true });
    if (error) throw error;
    const list = (data || []).map(row => ({ id: row.id, name: row.name, image: publicImageUrl(row.image_path), createdAt: Number(row.created_at) || Date.now() }));
    req.studio.chekis = list;
    res.set("Cache-Control", "no-store").json(list);
  } catch (error) {
    console.error("チェキ一覧取得失敗:", error?.message || error);
    res.status(500).json({ error: "保存済みチェキを読み込めませんでした。SupabaseのテーブルとStorageを確認してください。" });
  }
});
app.post("/api/studios/:id/chekis", requireStudio, async (req, res) => {
  const { id, image, name } = req.body || {};
  if (!id || typeof image !== "string" || !image.startsWith("data:image/png;base64,")) return res.status(400).json({ error: "id と PNG画像が必要です" });
  const studio = req.studio;
  let imagePath = "";
  try {
    imagePath = await uploadCheki(studio.id, id, image);
    const createdAt = Date.now();
    const { error } = await supabase.from("cheki_items").upsert({
      studio_id: studio.id, id: String(id), name: String(name || "チェキ"), image_path: imagePath, created_at: createdAt
    }, { onConflict: "studio_id,id" });
    if (error) throw error;
    const { data: verify, error: verifyError } = await supabase.from("cheki_items")
      .select("id,name,image_path,created_at")
      .eq("studio_id", studio.id).eq("id", String(id)).maybeSingle();
    if (verifyError) throw verifyError;
    if (!verify || verify.image_path !== imagePath) throw new Error("保存後の確認に失敗しました。");
    const saved = { id: verify.id, name: verify.name, image: publicImageUrl(verify.image_path), createdAt: Number(verify.created_at) || createdAt };
    studio.chekis = studio.chekis.filter(item => item.id !== saved.id);
    studio.chekis.push(saved);
    res.status(201).json({ ok: true, count: studio.chekis.length, cheki: saved, verified: true });
  } catch (error) {
    if (imagePath) {
      const { error: cleanupError } = await supabase.storage.from(STORAGE_BUCKET).remove([imagePath]);
      if (cleanupError) console.warn("失敗した保存画像の後片付けに失敗:", cleanupError.message);
    }
    console.error("チェキ保存失敗:", error?.message || error);
    res.status(500).json({ error: `チェキを保存できませんでした: ${error?.message || "Supabaseへの保存に失敗しました"}` });
  }
});
app.delete("/api/studios/:id/chekis/:chekiId", requireStudio, async (req, res) => {
  const studio = req.studio;
  try {
    const { data: existing, error: findError } = await supabase.from("cheki_items")
      .select("image_path").eq("studio_id", studio.id).eq("id", req.params.chekiId).maybeSingle();
    if (findError) throw findError;
    const { error } = await supabase.from("cheki_items").delete().eq("studio_id", studio.id).eq("id", req.params.chekiId);
    if (error) throw error;
    if (existing?.image_path) {
      const { error: storageError } = await supabase.storage.from(STORAGE_BUCKET).remove([existing.image_path]);
      if (storageError) console.warn("画像ファイルの後片付けに失敗:", storageError.message);
    }
    studio.chekis = studio.chekis.filter(item => item.id !== req.params.chekiId);
    res.json({ ok: true });
  } catch (error) {
    console.error("チェキ削除失敗:", error?.message || error);
    res.status(500).json({ error: "チェキを削除できませんでした。" });
  }
});

function dispatchGift(studio, { giftName, giftId = "", userName = "", isTest = false }) {
  if (!studio.chekis.length) return null;
  const picked = studio.chekis[Math.floor(Math.random() * studio.chekis.length)];
  broadcast(studio.id, { type: "show-cheki", cheki: picked, giftName: String(giftName || "ギフト"), giftId: String(giftId), userName: String(userName), isTest: Boolean(isTest), at: Date.now() });
  return picked;
}
app.post("/api/studios/:id/gift", requireStudio, (req,res) => {
  const b=req.body||{}; const picked=dispatchGift(req.studio,{giftName:b.giftName||"テストギフト",giftId:b.giftId||"",userName:b.userName||"",isTest:b.isTest||false});
  if(!picked) return res.status(409).json({error:"チェキを先に1枚以上登録してください。"});
  res.json({ok:true,selected:picked.name});
});
function giftMatches(studio, event) {
  if (studio.settings.giftMode !== "specific") return true;
  const q=studio.settings.giftQuery.trim().toLocaleLowerCase(); if(!q) return false;
  return q===String(event.giftId||"").toLocaleLowerCase() || q===String(event.giftName||"").toLocaleLowerCase();
}
async function disconnectTikTok(studio, manual=true) {
  if(manual) studio.manualDisconnect=true;
  if(studio.reconnectTimer) clearTimeout(studio.reconnectTimer);
  studio.reconnectTimer=null; studio.connectionToken++;
  const old=studio.connection; studio.connection=null; studio.connecting=false; studio.state="disconnected";
  if(old) try { await old.disconnect(); } catch(e) { console.warn("TikTok切断:",e?.message||e); }
}
function scheduleReconnect(studio, delay=15000) {
  if(studio.manualDisconnect || !studio.settings.username || studio.reconnectTimer) return;
  studio.reconnectTimer=setTimeout(()=>{studio.reconnectTimer=null; void connectTikTok(studio);},delay);
}
async function connectTikTok(studio) {
  if(!studio.settings.username || studio.connecting || studio.state==="connected") return;
  studio.manualDisconnect=false; studio.connecting=true; studio.state="connecting"; studio.lastError="";
  const token=++studio.connectionToken, username=studio.settings.username;
  const connection=new TikTokLiveClient(username), tracker=new GiftStreakTracker(); studio.connection=connection;
  connection.on(EventType.gift,event=>{
    if(token!==studio.connectionToken) return;
    const gift=event?.gift||{}; const id=String(gift.id??event.giftId??event.gift_id??""); const name=String(gift.name||event.giftName||event.gift_name||(id?`ギフト ${id}`:"ギフト"));
    const observed=normalizeGift({id,name,diamond_count:gift.diamondCount??gift.diamond_count??event.diamondCount??event.diamond_count,image:gift.image??gift.icon});
    if(observed) studio.observedGifts.set(observed.id||observed.name,observed);
    let streak; try { streak=tracker.process(event); } catch {}
    if(streak && streak.isFinal===false) return;
    if(!giftMatches(studio,{giftId:id,giftName:name})) return;
    dispatchGift(studio,{giftName:name,giftId:id,userName:event?.user?.nickname||event?.user?.uniqueId||"TikTokユーザー"});
  });
  connection.on("reconnecting",()=>{if(token===studio.connectionToken) studio.state="connecting";});
  connection.on("disconnected",()=>{if(token===studio.connectionToken){studio.state="disconnected";if(!studio.manualDisconnect)scheduleReconnect(studio,20000);}});
  connection.on("error",e=>{if(token===studio.connectionToken){studio.lastError=String(e?.message||e||"接続エラー");console.error(`TikTok接続エラー (${studio.id}):`,studio.lastError);}});
  try { const roomId=await connection.connect(); if(token!==studio.connectionToken)return; studio.state="connected";studio.lastError="";console.log(`TikTok接続成功 @${username} (${studio.id}, ${roomId})`); }
  catch(e){if(token===studio.connectionToken){studio.state="disconnected";studio.connection=null;studio.lastError=String(e?.message||e||"接続できませんでした");console.error(`TikTok接続失敗 (${studio.id}):`,studio.lastError);scheduleReconnect(studio,30000);}}
  finally {if(token===studio.connectionToken)studio.connecting=false;}
}
app.post("/api/studios/:id/tiktok/refresh", requireStudio, async (_req,res)=>{const result=await fetchGiftCatalog();res.status(result.ok?200:502).json({...result,availableGifts:cachedGiftCatalog,giftCatalogUpdatedAt,giftCatalogError});});
app.post("/api/studios/:id/tiktok/connect", requireStudio, async (req,res)=>{
  const s=req.studio, username=String(req.body?.username||"").trim().replace(/^@/,""), giftMode=req.body?.giftMode==="specific"?"specific":"all", giftQuery=String(req.body?.giftQuery||"").trim();
  if(!username)return res.status(400).json({error:"TikTokユーザーIDを入力してください。"});
  if(giftMode==="specific"&&!giftQuery)return res.status(400).json({error:"対象ギフトを選択してください。"});
  await disconnectTikTok(s,true); s.settings={username,giftMode,giftQuery}; try{await persistStudio(s);}catch(error){console.error("TikTok設定保存失敗:",error?.message||error);return res.status(500).json({error:"設定を保存できませんでした。"});}
  s.manualDisconnect=false; void connectTikTok(s); res.json({ok:true});
});
app.post("/api/studios/:id/tiktok/disconnect", requireStudio, async(req,res)=>{await disconnectTikTok(req.studio,true);res.json({ok:true});});

const dist=path.join(root,"dist");
if(fs.existsSync(dist)){app.use(express.static(dist));app.get("*",(_req,res)=>res.sendFile(path.join(dist,"index.html")));}

// DBの読み込み完了前にリクエストを受けないよう、初期化後に待受を開始する。
await migrateLocalStudios();
await loadStudioRows();
for (const studio of studios.values()) {
  if (studio.settings.username) setTimeout(() => void connectTikTok(studio), 1000);
}
server.listen(process.env.PORT || 3001, () => console.log(`Cheki server: http://localhost:${process.env.PORT || 3001}`));
void fetchGiftCatalog();
