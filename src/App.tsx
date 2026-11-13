import { useEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import type { Cheki, GiftEvent } from "./types";

const W = 720;
const H = 900;

const PHOTO = {
  x: 62,
  y: 62,
  w: 596,
  h: 596
};

// ギフト後のフラッシュ時間
const FLASH_DURATION = 460;

// チェキ表示時間は全ギフト共通で3秒
const DISPLAY_DURATION = 3000;

function makeId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function currentStudio() {
  const match = window.location.pathname.match(/^\/studio\/([a-f0-9]{32})\/(admin|overlay)\/?$/);
  const params = new URLSearchParams(window.location.search);
  return { id: match?.[1] || "", page: match?.[2] || "", adminKey: params.get("key") || "", viewKey: params.get("view") || "" };
}

async function studioFetch(path: string, options: RequestInit = {}) {
  const studio = currentStudio();
  const headers = new Headers(options.headers || {});
  if (studio.adminKey) headers.set("X-Studio-Admin-Key", studio.adminKey);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(`/api/studios/${studio.id}${path}`, { ...options, headers });
}

export default function App() {
  const studio = currentStudio();
  if (!studio.id) return <Landing />;
  return studio.page === "overlay" ? <Overlay /> : studio.page === "admin" && studio.adminKey ? <Editor /> : <InvalidStudio />;
}

function Landing() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function createStudio() {
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/studios", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "スタジオを作成できませんでした。");
      window.location.href = data.adminUrl;
    } catch (e) { setError(e instanceof Error ? e.message : "作成に失敗しました。"); setBusy(false); }
  }
  return <main className="landing-shell"><div className="landing-card"><div className="eyebrow">LIVE CREATOR TOOL</div><h1>CHEKI STUDIO</h1><p>ギフトに反応する、あなただけのチェキ演出。</p><div className="landing-features"><span>登録不要</span><span>無料でスタート</span><span>専用URLを自動発行</span></div><button className="primary landing-create" onClick={createStudio} disabled={busy}>{busy ? "スタジオを作成中…" : "スタジオを作成する"}</button>{error && <p className="notice">{error}</p>}<small>作成後に表示される管理用URLは、設定を変更するための鍵です。大切に保管してください。</small></div></main>;
}

function InvalidStudio() {
  return <main className="landing-shell"><div className="landing-card"><h1>スタジオを開けません</h1><p>URLが正しくないか、管理用キーがありません。</p><a className="overlay-link" href="/">トップページへ戻る</a></div></main>;
}

// ======================================
// 管理画面
// ======================================

function Editor() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const testAudioRef = useRef<HTMLAudioElement | null>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);

  const [color, setColor] = useState("#ff4f91");
  const [width, setWidth] = useState(7);
  const [glitter, setGlitter] = useState(false);
  const [name, setName] = useState("チェキ");

  const [chekis, setChekis] = useState<Cheki[]>([]);
  const [notice, setNotice] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [tiktokUsername, setTiktokUsername] = useState("");
  const [giftMode, setGiftMode] = useState<"all" | "specific">("all");
  const [giftQuery, setGiftQuery] = useState("");
  const [tiktokStatus, setTiktokStatus] = useState<{
    connected: boolean; connecting: boolean; state: string; lastError?: string;
  }>({ connected: false, connecting: false, state: "disconnected" });
  const [tiktokBusy, setTiktokBusy] = useState(false);
  const [availableGifts, setAvailableGifts] = useState<Array<{ id: string; name: string; coinCount: number | null; imageUrl: string }>>([]);
  const [giftSearch, setGiftSearch] = useState("");
  const [giftRefreshBusy, setGiftRefreshBusy] = useState(false);
  const [giftCatalogUpdatedAt, setGiftCatalogUpdatedAt] = useState<string | null>(null);
  const [giftCatalogError, setGiftCatalogError] = useState("");

  useEffect(() => {
    loadChekis();
    loadTikTokSettings();

    // 管理画面の「テストギフトを送る」ボタンはユーザー操作なので、
    // この画面側でMP3を直接再生できる。
    const audio = new Audio("/shutter.mp3?v=3");
    audio.preload = "auto";
    audio.volume = 0.9;
    testAudioRef.current = audio;

    return () => {
      audio.pause();
      audio.currentTime = 0;
      testAudioRef.current = null;
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void loadTikTokSettings(true);
    }, 2500);
    return () => window.clearInterval(timer);
  }, []);

  // チェキ一覧読み込み
  async function loadChekis() {
    try {
      const r = await studioFetch("/chekis", {
        cache: "no-store"
      });

      if (!r.ok) {
        throw new Error("一覧の読み込みに失敗しました");
      }

      setChekis(await r.json());
    } catch {
      setNotice(
        "サーバーに接続できません。npm run dev を起動してください。"
      );
    }
  }

  async function loadTikTokSettings(preserveForm = false) {
    try {
      const r = await studioFetch("/status", { cache: "no-store" });
      if (!r.ok) return;
      const data = await r.json();
      if (!preserveForm) {
        setTiktokUsername(data.username || "");
        setGiftMode(data.giftMode === "specific" ? "specific" : "all");
        setGiftQuery(data.giftQuery || "");
      }
      setAvailableGifts(Array.isArray(data.availableGifts) ? data.availableGifts : []);
      setGiftCatalogUpdatedAt(data.giftCatalogUpdatedAt || null);
      setGiftCatalogError(data.giftCatalogError || "");
      setTiktokStatus({
        connected: Boolean(data.connected),
        connecting: Boolean(data.connecting),
        state: data.state || "disconnected",
        lastError: data.lastError || ""
      });
    } catch {
      // TikTok設定の取得失敗はチェキ編集機能に影響させない。
    }
  }

  async function refreshTikTokGifts() {
    setGiftRefreshBusy(true);
    try {
      const r = await studioFetch("/tiktok/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: tiktokUsername }) });
      const data = await r.json();
      setAvailableGifts(Array.isArray(data.availableGifts) ? data.availableGifts : []);
      setGiftCatalogUpdatedAt(data.giftCatalogUpdatedAt || null);
      setGiftCatalogError(data.giftCatalogError || data.error || "");
      if (!r.ok) throw new Error(data.error || "ギフト一覧を取得できませんでした。");
      setNotice((data.count || data.availableGifts?.length || 0) + "件のギフトを取得しました。コイン数の安い順に表示しています。");
    } catch (error) { setNotice(error instanceof Error ? error.message : "ギフト一覧を取得できませんでした。"); }
    finally { setGiftRefreshBusy(false); }
  }

  async function connectTikTok() {
    setTiktokBusy(true);
    try {
      const r = await studioFetch("/tiktok/connect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: tiktokUsername, giftMode, giftQuery })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "TikTokに接続できませんでした。");
      setTiktokStatus({
        connected: Boolean(data.connected),
        connecting: Boolean(data.connecting),
        state: data.state || "connecting",
        lastError: data.lastError || ""
      });
      setNotice("TikTokへの接続を開始しました。LIVE中であれば接続状態が更新されます。");
      window.setTimeout(() => loadTikTokSettings(true), 1200);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "TikTokに接続できませんでした。");
    } finally {
      setTiktokBusy(false);
    }
  }

  async function disconnectTikTok() {
    setTiktokBusy(true);
    try {
      const r = await studioFetch("/tiktok/disconnect", { method: "POST" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "切断できませんでした。");
      setTiktokStatus({ connected: false, connecting: false, state: "disconnected" });
      setNotice("TikTokとの接続を切断しました。");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "切断できませんでした。");
    } finally {
      setTiktokBusy(false);
    }
  }

  // 描画履歴保存
  function saveHistory() {
    const c = canvasRef.current;

    if (c) {
      setHistory(h => [...h.slice(-19), c.toDataURL()]);
    }
  }

  // マウス座標変換
  function point(e: PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();

    return {
      x: (e.clientX - rect.left) * W / rect.width,
      y: (e.clientY - rect.top) * H / rect.height
    };
  }

  // 描画開始
  function start(e: PointerEvent<HTMLCanvasElement>) {
    const c = canvasRef.current;

    if (!c) return;

    saveHistory();

    drawing.current = true;
    last.current = point(e);

    c.setPointerCapture(e.pointerId);
  }

  // 描画中
  function move(e: PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || !last.current) return;

    const c = canvasRef.current;
    const ctx = c?.getContext("2d");

    if (!ctx) return;

    const p = point(e);

    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = width;

    if (glitter) {
      ctx.strokeStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 12;
      ctx.globalAlpha = 0.9;
      ctx.setLineDash([1, Math.max(2, width * 0.8)]);
    } else {
      ctx.strokeStyle = color;
      ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
    }

    ctx.beginPath();
    ctx.moveTo(last.current.x, last.current.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();

    // ラメ
    if (glitter) {
      for (let i = 0; i < 2; i++) {
        const t = Math.random();

        const sx =
          last.current.x +
          (p.x - last.current.x) * t +
          (Math.random() - 0.5) * 13;

        const sy =
          last.current.y +
          (p.y - last.current.y) * t +
          (Math.random() - 0.5) * 13;

        ctx.setLineDash([]);
        ctx.fillStyle = "#fff";
        ctx.globalAlpha = 0.95;

        ctx.beginPath();
        ctx.arc(
          sx,
          sy,
          Math.random() * 2.2 + 1,
          0,
          Math.PI * 2
        );
        ctx.fill();
      }
    }

    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.setLineDash([]);

    last.current = p;
  }

  function end() {
    drawing.current = false;
    last.current = null;
  }

  // 取り消し
  function undo() {
    const c = canvasRef.current;
    const previous = history[history.length - 1];

    if (!c || !previous) return;

    const img = new Image();

    img.onload = () => {
      const ctx = c.getContext("2d");

      ctx?.clearRect(0, 0, W, H);
      ctx?.drawImage(img, 0, 0);
    };

    img.src = previous;

    setHistory(h => h.slice(0, -1));
  }

  // 全消去
  function clear() {
    saveHistory();

    canvasRef.current
      ?.getContext("2d")
      ?.clearRect(0, 0, W, H);
  }

  // チェキ保存
  async function save() {
    const c = canvasRef.current;

    if (!c) return;

    // 白いフレーム + 中央透明のPNGを生成
    const output = document.createElement("canvas");

    output.width = W;
    output.height = H;

    const out = output.getContext("2d");

    if (!out) return;

    out.fillStyle = "#fff";
    out.fillRect(0, 0, W, H);

    // 写真部分を透明化
    out.clearRect(
      PHOTO.x,
      PHOTO.y,
      PHOTO.w,
      PHOTO.h
    );

    // 落書きを重ねる
    out.drawImage(c, 0, 0);

    out.fillStyle = "#aaa0a0";
    out.font = "18px sans-serif";

    out.fillText("INSTANT MOMENT", 62, 842);
    out.fillText("♥", 620, 842);

    out.strokeStyle = "#eee8e5";
    out.lineWidth = 2;

    out.strokeRect(1, 1, W - 2, H - 2);

    const image = output.toDataURL("image/png");

    try {
      const r = await studioFetch("/chekis", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          id: makeId(),
          name,
          image
        })
      });

      if (!r.ok) {
        throw new Error("保存に失敗しました");
      }

      setNotice("チェキを保存しました！");

      await loadChekis();
    } catch {
      setNotice(
        "保存できませんでした。サーバーが起動しているか確認してください。"
      );
    }
  }

  // チェキ削除
  async function remove(id: string) {
    try {
      const r = await studioFetch(
        `/chekis/${encodeURIComponent(id)}`,
        { method: "DELETE" }
      );

      if (!r.ok) {
        throw new Error("削除に失敗しました");
      }

      await loadChekis();
      setNotice("チェキを削除しました。");
    } catch {
      setNotice("チェキを削除できませんでした。");
    }
  }

  // テストギフト
  async function testGift() {
    // ボタンを押した管理画面側で音を鳴らす。
    // オーバーレイ側でも二重再生しないよう isTest を付ける。
    const soundPlayed = await playShutterSound(testAudioRef.current);

    try {
      const r = await studioFetch("/gift", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          giftName: "テストギフト",
          userName: "テストユーザー",
          isTest: true
        })
      });

      setNotice(
        r.ok
          ? (soundPlayed
              ? "テスト音を再生し、テストギフトを送信しました。オーバーレイを確認してね！"
              : "テストギフトを送信しました。音が鳴らない場合は public/shutter.mp3 が読み込めているか確認してください。")
          : "先にチェキを1枚以上保存してください。"
      );
    } catch {
      setNotice("テストギフトを送信できませんでした。");
    }
  }

  return (
    <main className="app-shell">

      <header className="topbar">
        <div>
          <div className="eyebrow">LIVE CREATOR TOOL</div>
          <h1>Cheki Studio</h1>
        </div>

        <nav className="topbar-links">
          <a className="overlay-link" href={`/studio/${currentStudio().id}/overlay?view=${currentStudio().viewKey}`} target="_blank">オーバーレイを開く ↗</a>
          <a className="overlay-link" href="/">トップへ</a>
        </nav>
      </header>

      <div className="intro">
        <h2>チェキをつくろう。</h2>
        <p>
          中央の写真窓は透明です。配信画面がそのまま見え、
          フレームと落書きだけが重なります。
        </p>
      </div>

      <section className="tiktok-panel">
        <div className="tiktok-panel-head">
          <div>
            <span className="step">TIKTOK LIVE</span>
            <h2>TikTok連携</h2>
            <p>配信者IDを入力して接続すると、選択したギフトに反応してチェキが表示されます。</p>
          </div>
          <span className={`connection-state ${tiktokStatus.connected ? "is-connected" : tiktokStatus.connecting ? "is-connecting" : ""}`}>
            <i />{tiktokStatus.connected ? "接続中" : tiktokStatus.connecting ? "接続処理中" : "未接続"}
          </span>
        </div>
        <div className="tiktok-controls">
          <label className="field">
            TikTokユーザーID
            <input
              value={tiktokUsername}
              onChange={e => setTiktokUsername(e.target.value.replace(/^@/, ""))}
              placeholder="例：your_tiktok_id（@不要）"
              autoComplete="off"
            />
          </label>
          <label className="field">
            反応するギフト
            <select value={giftMode} onChange={e => setGiftMode(e.target.value as "all" | "specific")}>
              <option value="all">すべてのギフト</option>
              <option value="specific">指定したギフトのみ</option>
            </select>
          </label>
          {giftMode === "specific" && (
            <div className="gift-query-field">
              <div className="gift-catalog-toolbar">
                <label className="field">ギフトを検索<input value={giftSearch} onChange={e => setGiftSearch(e.target.value)} placeholder="ギフト名・ギフトIDで検索" /></label>
                <button className="secondary" type="button" onClick={refreshTikTokGifts} disabled={giftRefreshBusy}>{giftRefreshBusy ? "取得中…" : "日本のギフト一覧を取得・更新"}</button>
              </div>
              <div className="gift-catalog-meta"><span>{availableGifts.length.toLocaleString()}件のギフト</span><span>コイン数の安い順</span>{giftCatalogUpdatedAt && <span>最終取得：{new Date(giftCatalogUpdatedAt).toLocaleString("ja-JP")}</span>}</div>
              <div className="gift-catalog-list">
                {availableGifts.filter(gift => { const q = giftSearch.trim().toLocaleLowerCase(); return !q || gift.name.toLocaleLowerCase().includes(q) || gift.id.toLocaleLowerCase().includes(q); }).map(gift => (
                  <button type="button" key={gift.id || gift.name} className={"gift-catalog-item " + (giftQuery === (gift.id || gift.name) ? "is-selected" : "")} onClick={() => setGiftQuery(gift.id || gift.name)}>
                    {gift.imageUrl ? <img src={gift.imageUrl} alt="" loading="lazy" /> : <span className="gift-catalog-no-image">🎁</span>}
                    <span className="gift-catalog-name"><b>{gift.name}</b><small>ID: {gift.id || "不明"}</small></span>
                    <strong>{gift.coinCount !== null ? gift.coinCount.toLocaleString() + " コイン" : "価格不明"}</strong>
                  </button>
                ))}
                {!availableGifts.length && <p className="gift-catalog-empty">ギフト一覧がありません。サーバー起動時に自動取得します。「日本のギフト一覧を取得・更新」も試してください。</p>}
              </div>
              <label className="field">選択中のギフトID・名前（直接入力も可能）<input value={giftQuery} onChange={e => setGiftQuery(e.target.value)} placeholder="一覧から選択、またはID・名前を入力" /></label>
              {giftCatalogError && <p className="tiktok-error">一覧取得メモ：{giftCatalogError}</p>}
            </div>
          )}
          <div className="tiktok-actions">
            <button className="primary" onClick={connectTikTok} disabled={tiktokBusy || tiktokStatus.connecting}>
              {tiktokBusy || tiktokStatus.connecting ? "接続中…" : "TikTokに接続する"}
            </button>
            <button className="secondary" onClick={disconnectTikTok} disabled={tiktokBusy || (!tiktokStatus.connected && !tiktokStatus.connecting)}>
              切断
            </button>
            <button className="secondary" onClick={() => loadTikTokSettings()} disabled={tiktokBusy}>状態を更新</button>
            <button className="secondary" onClick={refreshTikTokGifts} disabled={giftRefreshBusy}>{giftRefreshBusy ? "ギフト取得中…" : "ギフト一覧を更新"}</button>
          </div>
        </div>
        <p className="tiktok-help">
          日本向け公開ギフトカタログを配信前に読み込みます。ギフトIDが公開データで照合できない場合は名前で選択できます。空欄の「すべてのギフト」では受信した全ギフトが対象です。接続には無料のPirateTok接続ライブラリを使用します。接続後の設定は自動保存されます。
        </p>
        {tiktokStatus.lastError && <p className="tiktok-error">{tiktokStatus.lastError}</p>}
      </section>

      <section className="workspace">

        <div className="editor-panel">

          <div className="section-head">
            <div>
              <span className="step">01</span>
              <b>デザインエディター</b>
            </div>

            <span className="hint">
              キャンバスに直接お絵描き
            </span>
          </div>

          <div className="canvas-wrap">

            <div className="photo-hole">
              PHOTO AREA
              <br />
              <small>ここは透過されます</small>
            </div>

            <canvas
              ref={canvasRef}
              width={W}
              height={H}
              onPointerDown={start}
              onPointerMove={move}
              onPointerUp={end}
              onPointerCancel={end}
            />

            <div className="frame-bottom">
              <span>INSTANT MOMENT</span>
              <span>♥</span>
            </div>

          </div>

          <div className="toolbar">

            <label>
              ペンの色
              <input
                aria-label="ペンの色"
                type="color"
                value={color}
                onChange={e => setColor(e.target.value)}
              />
            </label>

            <label className="size-control">
              太さ
              <input
                type="range"
                min="2"
                max="24"
                value={width}
                onChange={e => setWidth(Number(e.target.value))}
              />
              <b>{width}px</b>
            </label>

            <label className="toggle">
              <input
                type="checkbox"
                checked={glitter}
                onChange={e => setGlitter(e.target.checked)}
              />
              ✨ ラメペン
            </label>

            <button
              className="secondary"
              onClick={undo}
              disabled={!history.length}
            >
              ↶ 取り消す
            </button>

            <button
              className="secondary"
              onClick={clear}
            >
              消去
            </button>

          </div>
        </div>

        <aside className="settings-panel">

          <div className="section-head">
            <div>
              <span className="step">02</span>
              <b>保存設定</b>
            </div>
          </div>

          <label className="field">
            チェキの名前

            <input
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={30}
            />
          </label>

          <div className="note">
            <b>透過について</b>
            <p>
              白いチェキフレームは自動で付きます。
              写真窓には何も描かないでください。
              保存されるPNGも中央が透明になります。
            </p>
          </div>

          <button
            className="primary save-btn"
            onClick={save}
          >
            チェキを保存する
          </button>

          {notice && (
            <p className="notice">{notice}</p>
          )}

          <div className="divider" />

          <div className="section-head">
            <div>
              <span className="step">03</span>
              <b>表示設定</b>
            </div>
          </div>

          <div className="fixed-duration">
            <span className="duration-number">3</span>
            <span className="duration-unit">秒</span>
          </div>

          <p className="small-copy">
            すべてのギフトでチェキの表示時間は3秒に統一されています。
          </p>

          <div className="divider" />

          <div className="section-head">
            <div>
              <span className="step">04</span>
              <b>配信テスト</b>
            </div>
          </div>

          <p className="small-copy">
            保存したチェキからランダムで1枚選び、
            オーバーレイに表示します。
          </p>

          <button
            className="secondary full"
            onClick={testGift}
          >
            🎁 テストギフトを送る
          </button>

          <p className="small-copy">
            オーバーレイURL：<code>{window.location.origin}/studio/{currentStudio().id}/overlay?view={currentStudio().viewKey}</code>
          </p>

        </aside>
      </section>

      <footer>
        Cheki Studio · Gift-triggered transparent Polaroid overlay
      </footer>

    </main>
  );
}

// ======================================
// MP3シャッター音
// ======================================

async function playShutterSound(audio: HTMLAudioElement | null): Promise<boolean> {
  if (!audio) return false;

  try {
    audio.pause();
    audio.currentTime = 0;
    await audio.play();
    return true;
  } catch (error) {
    console.warn("シャッター音を再生できませんでした:", error);
    return false;
  }
}

// ======================================
// オーバーレイ
// ======================================

function Overlay() {
  const [event, setEvent] = useState<GiftEvent | null>(null);
  const [flash, setFlash] = useState(false);
  const [visible, setVisible] = useState(false);
  const [flashKey, setFlashKey] = useState(0);
  const timers = useRef<number[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    // public/shutter.mp3 を読み込む
    const audio = new Audio("/shutter.mp3?v=3");

    audio.preload = "auto";
    audio.volume = 0.9;

    audioRef.current = audio;
    audio.load();

    // 表示用ボタンは置かず、OBSの「対話」画面などで最初に操作された時に
    // ミュート再生でブラウザの音声制限解除を試みる。
    const unlockAudio = () => {
      audio.muted = true;
      void audio.play().then(() => {
        audio.pause();
        audio.currentTime = 0;
        audio.muted = false;
      }).catch(() => {
        audio.muted = false;
      });
    };
    window.addEventListener("pointerdown", unlockAudio, { once: true });
    window.addEventListener("keydown", unlockAudio, { once: true });

    let ws: WebSocket | null = null;
    let retry = 0;
    let disposed = false;

    const clearTimers = () => {
      timers.current.forEach(t => {
        window.clearTimeout(t);
      });

      timers.current = [];
    };

    const connect = () => {
      if (disposed) return;

      const protocol =
        location.protocol === "https:" ? "wss:" : "ws:";

      const studio = currentStudio();
      ws = new WebSocket(
        `${protocol}//${location.host}/ws?studio=${encodeURIComponent(studio.id)}&view=${encodeURIComponent(studio.viewKey)}`
      );

      ws.onmessage = e => {
        try {
          const data = JSON.parse(e.data) as
            GiftEvent & { isTest?: boolean };

          if (data.type !== "show-cheki") return;

          clearTimers();

          setVisible(false);
          setEvent(data);
          setFlashKey(key => key + 1);

          // テストギフトの音は管理画面側で再生済み。
          // 実ギフトではオーバーレイ側で自動再生を試みる。
          if (!data.isTest) {
            void playShutterSound(audioRef.current);
          }

          // フラッシュ開始
          setFlash(true);

          // フラッシュ終了後にチェキ表示
          timers.current.push(
            window.setTimeout(() => {
              setFlash(false);
              setVisible(true);
            }, FLASH_DURATION)
          );

          // 全ギフト共通で3秒表示
          timers.current.push(
            window.setTimeout(() => {
              setVisible(false);
            }, FLASH_DURATION + DISPLAY_DURATION)
          );

        } catch (error) {
          console.warn(
            "ギフトイベントの処理に失敗:",
            error
          );
        }
      };

      ws.onclose = () => {
        if (!disposed) {
          retry = window.setTimeout(connect, 2000);
        }
      };

      ws.onerror = () => {
        ws?.close();
      };
    };

    connect();

    return () => {
      disposed = true;

      if (ws) {
        ws.onclose = null;
        ws.close();
      }

      window.clearTimeout(retry);
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);

      clearTimers();

      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
        audioRef.current = null;
      }
    };
  }, []);

  return (
    <div className={`overlay-stage ${flash ? "flash-active" : ""}`}>


      {flash && (
        <div key={flashKey} className="camera-flash" aria-hidden="true">
          <div className="flash-screen" />
          <div className="flash-rays" />
          <div className="flash-core" />
          <div className="flash-ring" />
        </div>
      )}

      {event && (
        <div
          className={`fly-cheki ${visible ? "show" : ""}`}
        >
          <img
            src={event.cheki.image}
            alt="チェキ"
          />

          {event.userName && (
            <div className="gift-caption">
              {event.userName} さんからの{" "}
              {event.giftName || "ギフト"}
            </div>
          )}
        </div>
      )}

    </div>
  );
}