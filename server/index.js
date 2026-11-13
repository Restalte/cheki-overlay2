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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const dataDir = path.join(root, "data");
const studiosDir = path.join(dataDir, "studios");
const giftCatalogFile = path.join(dataDir, "tiktok-gifts.json");
fs.mkdirSync(studiosDir, { recursive: true });

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

function readStudio(id) {
  try {
    const data = JSON.parse(fs.readFileSync(studioFile(id), "utf8"));
    return {
      id, adminKey: data.adminKey, viewKey: data.viewKey,
      chekis: Array.isArray(data.chekis) ? data.chekis : [],
      settings: {
        username: String(data.settings?.username || "").trim().replace(/^@/, ""),
        giftMode: data.settings?.giftMode === "specific" ? "specific" : "all",
        giftQuery: String(data.settings?.giftQuery || "").trim()
      },
      state: "disconnected", lastError: "", connection: null, connecting: false,
      manualDisconnect: false, connectionToken: 0, reconnectTimer: null,
      observedGifts: new Map()
    };
  } catch { return null; }
}
function persistStudio(studio) {
  fs.mkdirSync(studioDir(studio.id), { recursive: true });
  const { id, adminKey, viewKey, chekis, settings } = studio;
  fs.writeFileSync(studioFile(id), JSON.stringify({ id, adminKey, viewKey, chekis, settings }, null, 2), "utf8");
}
function getStudio(id) { return studios.get(id) || null; }

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

const server = app.listen(process.env.PORT || 3001, () => console.log(`Cheki server: http://localhost:${process.env.PORT || 3001}`));
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
app.post("/api/studios", (_req, res) => {
  const id = crypto.randomBytes(16).toString("hex");
  const studio = { id, adminKey: randomToken(), viewKey: randomToken(), chekis: [], settings: { username: "", giftMode: "all", giftQuery: "" }, state: "disconnected", lastError: "", connection: null, connecting: false, manualDisconnect: false, connectionToken: 0, reconnectTimer: null, observedGifts: new Map() };
  studios.set(id, studio); persistStudio(studio);
  res.status(201).json({ id, adminKey: studio.adminKey, viewKey: studio.viewKey, adminUrl: `/studio/${id}/admin?key=${studio.adminKey}`, overlayUrl: `/studio/${id}/overlay?view=${studio.viewKey}` });
});

app.get("/api/studios/:id/status", requireStudio, (req, res) => {
  const s = req.studio;
  const gifts = new Map();
  for (const g of [...cachedGiftCatalog, ...s.observedGifts.values()]) gifts.set(g.id || g.name, { ...(gifts.get(g.id || g.name) || {}), ...g });
  res.set("Cache-Control", "no-store").json({ username: s.settings.username, giftMode: s.settings.giftMode, giftQuery: s.settings.giftQuery, connected: s.state === "connected", connecting: s.state === "connecting", state: s.state, lastError: s.lastError, availableGifts: [...gifts.values()].sort((a,b) => (a.coinCount ?? Number.MAX_SAFE_INTEGER) - (b.coinCount ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name,"ja")), giftCatalogUpdatedAt, giftCatalogError });
});
app.get("/api/studios/:id/chekis", requireStudio, (req,res) => res.set("Cache-Control","no-store").json(req.studio.chekis));
app.post("/api/studios/:id/chekis", requireStudio, (req,res) => {
  const { id, image, name } = req.body || {};
  if (!id || typeof image !== "string" || !image.startsWith("data:image/png;base64,")) return res.status(400).json({ error: "id と PNG画像が必要です" });
  const s = req.studio; s.chekis = s.chekis.filter(x => x.id !== id); s.chekis.push({ id, name: String(name || "チェキ"), image, createdAt: Date.now() });
  try { persistStudio(s); res.json({ ok: true, count: s.chekis.length }); } catch(e) { res.status(500).json({ error: "保存できませんでした" }); }
});
app.delete("/api/studios/:id/chekis/:chekiId", requireStudio, (req,res) => { const s=req.studio; s.chekis=s.chekis.filter(x=>x.id!==req.params.chekiId); try { persistStudio(s); res.json({ok:true}); } catch { res.status(500).json({error:"削除できませんでした"}); } });

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
  await disconnectTikTok(s,true); s.settings={username,giftMode,giftQuery}; try{persistStudio(s);}catch{return res.status(500).json({error:"設定を保存できませんでした。"});}
  s.manualDisconnect=false; void connectTikTok(s); res.json({ok:true});
});
app.post("/api/studios/:id/tiktok/disconnect", requireStudio, async(req,res)=>{await disconnectTikTok(req.studio,true);res.json({ok:true});});

// Restore each studio from persistent storage and reconnect configured TikTok accounts.
for (const entry of fs.readdirSync(studiosDir,{withFileTypes:true})) {
  if(!entry.isDirectory()||!safeId(entry.name)) continue;
  const studio=readStudio(entry.name); if(!studio) continue; studios.set(studio.id,studio);
  if(studio.settings.username) setTimeout(()=>void connectTikTok(studio),1000);
}
void fetchGiftCatalog();

const dist=path.join(root,"dist");
if(fs.existsSync(dist)){app.use(express.static(dist));app.get("*",(_req,res)=>res.sendFile(path.join(dist,"index.html")));}
