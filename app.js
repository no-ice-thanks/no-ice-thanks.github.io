/* ==========================================================================
   文字冰塊 — app.js
   Vanilla JavaScript，無任何依賴。以 IIFE 封裝，不污染全域。

   冰塊 lifecycle（狀態機）：
     water     在水中（點擊 → rising）
     rising    上浮動畫中（rAF 浮力彈簧模型，不可點擊）
     surfaced  停在水面輕微漂浮（點擊 → melting）
     melting   融化動畫中（不可點擊；資料保留）
     waiting   融化完成、元素已移除，等待 1.2–2 秒
     → water   重新凝結（保留文字與顏色，重新安排位置）
     dead      唯一的終點：設定面板垃圾桶 deleteCube()
               → 取消重生計時器、移除元素、從 cubes 與 localStorage 刪除

   資料與畫面分離：
   「cubes 陣列 = 使用者建立並保留的冰塊（= localStorage）」。
   DOM 元素與動畫狀態只是每個 entry 的 runtime 欄位
   （el / state / raf / riseCtx / respawnTimer）。
   上浮、融化、等待都不會刪除資料；融化後的冰塊會稍後自動重新出現。

   模組順序：
   1. 工具函式與安全儲存層
   2. DOM 參照與狀態
   3. 幾何計算（文字 → 冰塊尺寸/字級/比例）
   4. 冰塊元素產生與掛載
   5. 放置演算法（防重疊）
   6. 互動：上浮（rAF 彈簧）/ 融化 / 重新凝結 / 永久刪除
   7. localStorage
   8. 設定面板（原生 dialog + fallback）
   9. 音效（Web Audio API 程序化合成，含 iOS Safari 解鎖流程）
   10. 事件繫結與初始化
   ========================================================================== */
(function () {
  'use strict';

  /* --------------------------------------------------------------------------
   * 1. 工具函式
   * -------------------------------------------------------------------------- */

  var $ = function (sel, root) { return (root || document).querySelector(sel); };

  var clamp = function (v, min, max) { return Math.min(max, Math.max(min, v)); };
  var rand = function (min, max) { return min + Math.random() * (max - min); };

  var REDUCED = window.matchMedia('(prefers-reduced-motion: reduce)');

  var uid = function () {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  };

  /* 安全的 localStorage 包裝：隱私模式或 file:// 異常時退回記憶體模式 */
  var storage = {
    ok: true,
    get: function (key, fallback) {
      try {
        var raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch (e) {
        this.ok = false;
        return fallback;
      }
    },
    set: function (key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch (e) {
        this.ok = false;
      }
    }
  };

  var KEY_CUBES = 'iceGlass.cubes.v1';
  var KEY_SOUND = 'iceGlass.sound.v1';
  var MAX_CUBES = 8;    // 杯子容量上限（冰塊永久保留並循環重生，過多會永久堆疊）
  var MAX_TEXT = 24;    // 與 input maxlength 一致

  /* 融化完成後到重新凝結的等待時間（ms） */
  var RESPAWN_MIN = 1200;
  var RESPAWN_MAX = 2000;

  /* --------------------------------------------------------------------------
   * 2. DOM 參照與狀態
   * -------------------------------------------------------------------------- */

  var layer     = $('#iceLayer');
  var glassEl   = $('.glass');
  var dlg       = $('#settingsDialog');
  var listEl    = $('#cubeList');
  var emptyEl   = $('#emptyHint');
  var limitEl   = $('#limitHint');
  var addForm   = $('#addForm');
  var addBtn    = $('#addBtn');
  var textIn    = $('#cubeText');
  var colorIn   = $('#cubeColor');
  var openBtn   = $('#openSettings');
  var closeBtn  = $('#closeSettings');
  var soundBtn  = $('#soundToggle');

  /* cubes：使用者「建立並保留」的所有冰塊（= localStorage 的內容）。
   * 設定清單由這個陣列渲染；融化 / 等待中的冰塊也留在這裡。
   *
   * entry = {
   *   id, text, color,                 使用者資料（與設定清單同步）
   *   x, y, rot, variant, dur, delay,  位置與漂浮參數（x/y 為圖層分數座標）
   *   geom: {w, fs, ar},               文字擬合出的冰塊幾何
   *   state,                           water | rising | surfaced | melting | waiting | dead
   *   surfaced,                        是否停在水面（water / surfaced 用）
   *   el,                              DOM 元素（waiting / dead 時為 null）
   *   raf, riseCtx,                    上浮動畫的 rAF handle 與彈簧參數
   *   respawnTimer, safetyTimer        重生計時器 / 動畫保險計時器
   * } */
  var cubes = [];

  /* --------------------------------------------------------------------------
   * 3. 幾何計算
   * -------------------------------------------------------------------------- */

  /* 估算文字寬度單位：CJK ≈ 1、emoji ≈ 1.2、其他 ≈ 0.56 */
  var CJK_RE = /[\u2E80-\u9FFF\uF900-\uFAFF\uFF01-\uFF60\u3000-\u303F]/;
  var EMOJI_RE = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u2600-\u27BF]/;

  function textUnits(t) {
    var u = 0;
    for (var ch of t) {
      if (CJK_RE.test(ch)) u += 1;
      else if (EMOJI_RE.test(ch)) u += 1.2;
      else u += 0.56;
    }
    return u;
  }

  var FS_MAX = 0.074;   // 字級上限（相對冰塊圖層寬）
  var FS_MIN = 0.042;
  var WF_MIN = 0.24;    // 冰塊寬度範圍（相對冰塊圖層寬）
  var WF_MAX = 0.44;

  /* 依文字長度計算冰塊幾何：
   * 嘗試 1~3 行，選出字級最大且高度合理的方案；
   * 保持冰塊接近立方體比例（ar = 寬/高 ≈ 1~1.55）。 */
  function computeGeometry(text) {
    var units = Math.max(textUnits(text), 1);

    for (var lines = 1; lines <= 3; lines++) {
      var lu = units / lines;                       // 每行平均字寬單位
      var fs = Math.min(FS_MAX, (WF_MAX * 0.82) / lu);
      if (fs < FS_MIN) continue;

      var w = clamp((lu * fs) / 0.82 + 0.02, WF_MIN, WF_MAX);
      fs = Math.min(fs, (w * 0.82) / lu);           // 寬度被夾住後重新核對字級
      if (fs < FS_MIN) continue;

      var h = lines * fs * 1.36 + 0.18 * w;         // 行數 × 行高 + 上下內距
      h = clamp(h, w / 1.55, w / 0.95);             // 保持冰塊感（不過扁不過瘦長）
      if (h > 0.36) continue;

      return { w: w, fs: fs, ar: w / h };
    }

    /* 極端長文字的保底方案：最小字級 + 最寬冰塊 + 略增高度避免截字 */
    var fw = WF_MAX;
    var ff = FS_MIN * 0.92;
    var fh = 3.4 * ff * 1.36 + 0.18 * fw;
    return { w: fw, fs: ff, ar: fw / fh };
  }

  /* cqw 不支援時的 fallback 字級（相對玻璃外寬 --u） */
  function fsuFor(fs) {
    var lw = layer.clientWidth || 1;
    var gw = (glassEl && glassEl.clientWidth) || 1;
    return fs * (lw / gw);
  }

  /* 依文字顏色明暗決定柔光方向，維持可讀性 */
  function isLightColor(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return false;
    var n = parseInt(m[1], 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) > 168;
  }

  /* --------------------------------------------------------------------------
   * 4. 冰塊元素
   * -------------------------------------------------------------------------- */

  /* z-index 依深度：越淺越上層（光從上來的直覺） */
  function zFor(entry) {
    return 2 + Math.round((1 - entry.y) * 6);
  }

  function cubeElement(entry) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ice-cube';
    btn.dataset.id = entry.id;
    btn.setAttribute('aria-label', '冰塊：' + entry.text);

    var s = btn.style;
    s.setProperty('--x', entry.x.toFixed(4));
    s.setProperty('--y', entry.y.toFixed(4));
    s.setProperty('--w', entry.geom.w.toFixed(4));
    s.setProperty('--ar', entry.geom.ar.toFixed(3));
    s.setProperty('--fs', entry.geom.fs.toFixed(4));
    s.setProperty('--fsu', fsuFor(entry.geom.fs).toFixed(4));
    s.setProperty('--rot', entry.rot.toFixed(2) + 'deg');
    s.setProperty('--z', String(zFor(entry)));
    s.setProperty('--dur', entry.dur.toFixed(2) + 's');
    s.setProperty('--delay', entry.delay.toFixed(2) + 's');

    var floatEl = document.createElement('span');
    floatEl.className = 'cube-float';

    var body = document.createElement('span');
    body.className = 'cube-body v' + entry.variant;

    var txt = document.createElement('span');
    txt.className = 'cube-text ' + (isLightColor(entry.color) ? 'tc-light' : 'tc-dark');
    txt.style.setProperty('--tc', entry.color);
    txt.textContent = entry.text;

    body.appendChild(txt);
    floatEl.appendChild(body);
    btn.appendChild(floatEl);
    return btn;
  }

  /* 掛載冰塊元素。mode：
   *   'enter'  → 新建立的入場（pop-in）
   *   'reform' → 融化後重新凝結（柔和 fade-in + 輕微 scale-in）
   *   null     → 不播入場動畫（頁面載入） */
  function mountCube(entry, mode) {
    var el = cubeElement(entry);
    entry.el = el;
    entry.state = 'water';
    layer.appendChild(el);
    if (mode && !REDUCED.matches) {
      el.classList.add(mode);
      setTimeout(function () { el.classList.remove(mode); }, 720);
    }
  }

  /* --------------------------------------------------------------------------
   * 5. 放置演算法：隨機採樣 + AABB 防重疊（含安全間距）
   * -------------------------------------------------------------------------- */

  /* 浮在水面時的中心 y（冰塊約 16% 露出水面） */
  function surfacedY(entry) {
    var rect = layer.getBoundingClientRect();
    var hPx = (entry.geom.w * rect.width) / entry.geom.ar;
    return (hPx * 0.34) / rect.height;
  }

  /* 冰塊目前在圖層分數座標系的 AABB（只依賴資料欄位，不需要讀元素） */
  function currentBox(entry) {
    var rect = layer.getBoundingClientRect();
    var hPx = (entry.geom.w * rect.width) / entry.geom.ar;
    return {
      x: entry.x,
      y: entry.surfaced ? surfacedY(entry) : entry.y,
      wf: entry.geom.w,
      hf: hPx / rect.height
    };
  }

  function findPosition(geom, excludeEntry) {
    var rect = layer.getBoundingClientRect();
    var hPx = (geom.w * rect.width) / geom.ar;
    var hf = hPx / rect.height;
    var pad = 0.018;
    var minX = geom.w / 2 + pad, maxX = 1 - geom.w / 2 - pad;
    var minY = hf / 2 + pad, maxY = 1 - hf / 2 - pad;
    if (maxX < minX || maxY < minY) return { x: 0.5, y: 0.5 };

    /* 只把「目前看得到」的冰塊算進避讓對象（waiting / 已刪除沒有元素） */
    var others = cubes
      .filter(function (c) { return c !== excludeEntry && c.el; })
      .map(currentBox);

    var best = null, bestScore = -Infinity;

    /* 對候補位置評分 */
    function consider(x, y) {
      var score;
      if (others.length === 0) {
        /* 沒有其他可見冰塊（第一顆，或其餘都在融化/等待中）：
         * 偏好遠離中心的候補，把中央空間留給後續冰塊。 */
        var ex = (x - 0.5) * 2;
        var ey = (y - 0.5) * 2;
        score = 0.5 * (ex * ex + ey * ey) + Math.random() * 0.1;
      } else {
        score = Infinity;
        for (var j = 0; j < others.length; j++) {
          var o = others[j];
          var dx = Math.abs(x - o.x) - (geom.w + o.wf) / 2;
          var dy = Math.abs(y - o.y) - (hf + o.hf) / 2;
          /* AABB 分離度：兩軸其中之一分開即不重疊 → 取 max(dx, dy)。
           * （min 會把「左右並排」誤判成重疊，擁擠時導致放置失敗） */
          score = Math.min(score, Math.max(dx, dy));
        }
        /* 微小隨機打破平手：多個同等安全的角落時有自然的變化 */
        score += Math.random() * 0.004;
        /* 同等安全時偏好遠離中心：保留完整格位給後續的冰塊 */
        var ex2 = (x - 0.5) * 2;
        var ey2 = (y - 0.5) * 2;
        score += 0.02 * (ex2 * ex2 + ey2 * ey2);
      }
      /* 一律評估完所有候補、取最大分離度（不早停），
       * 確保後放的冰塊也能找到安全位置。 */
      if (score > bestScore) { bestScore = score; best = { x: x, y: y }; }
      return false;
    }

    /* 1) 隨機採樣 */
    var i, gx, gy;
    for (i = 0; i < 90; i++) {
      consider(rand(minX, maxX), rand(minY, maxY));
    }

    /* 2) 6×6 網格 + 抖動：涵蓋角落與邊帶，擁擠時比純隨機可靠 */
    var G = 6;
    for (gy = 0; gy < G; gy++) {
      for (gx = 0; gx < G; gx++) {
        var cx = minX + (maxX - minX) * (G === 1 ? 0.5 : gx / (G - 1));
        var cy = minY + (maxY - minY) * (G === 1 ? 0.5 : gy / (G - 1));
        consider(clamp(cx + rand(-0.02, 0.02), minX, maxX),
                 clamp(cy + rand(-0.02, 0.02), minY, maxY));
      }
    }

    /* 3) 10×10 純網格：最後的精緻搜尋 */
    var G2 = 10;
    for (gy = 0; gy < G2; gy++) {
      for (gx = 0; gx < G2; gx++) {
        consider(minX + (maxX - minX) * gx / (G2 - 1),
                 minY + (maxY - minY) * gy / (G2 - 1));
      }
    }

    return best || { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  }

  /* 檢查一個（尚未掛載或已存在的）entry 的位置是否在水體內且不與他人重疊 */
  function isPlacementOK(entry) {
    var rect = layer.getBoundingClientRect();
    var hPx = (entry.geom.w * rect.width) / entry.geom.ar;
    var hf = hPx / rect.height;
    var pad = 0.018;
    if (entry.x < entry.geom.w / 2 + pad - 1e-6 ||
        entry.x > 1 - entry.geom.w / 2 - pad + 1e-6) return false;
    if (entry.y < hf / 2 + pad - 1e-6 ||
        entry.y > 1 - hf / 2 - pad + 1e-6) return false;

    var box = currentBox(entry);
    for (var i = 0; i < cubes.length; i++) {
      var c = cubes[i];
      if (c === entry || !c.el) continue;
      var o = currentBox(c);
      var dx = Math.abs(box.x - o.x) - (box.wf + o.wf) / 2;
      var dy = Math.abs(box.y - o.y) - (box.hf + o.hf) / 2;
      if (dx < 0.008 && dy < 0.008) return false;
    }
    return true;
  }

  function addCube(text, color) {
    if (cubes.length >= MAX_CUBES) return false;
    var geom = computeGeometry(text);
    var pos = findPosition(geom, null);
    var entry = {
      id: uid(),
      text: text,
      color: color,
      x: pos.x, y: pos.y,
      rot: rand(-3.5, 3.5),
      variant: 1 + Math.floor(Math.random() * 4),
      dur: rand(6, 9.5),
      delay: -rand(0, 8),
      state: 'water',
      surfaced: false,
      geom: geom,
      el: null, raf: null, riseCtx: null,
      respawnTimer: null, safetyTimer: null
    };
    cubes.push(entry);
    mountCube(entry, 'enter');
    saveCubes();
    return true;
  }

  /* 文字修改後重新計算尺寸；若因此與鄰近冰塊重疊則重新找位置。
   * 融化中 / 等待重生中的冰塊只更新幾何資料，重生時自然套用。 */
  function refitCube(entry) {
    entry.geom = computeGeometry(entry.text);
    var el = entry.el;
    if (!el || entry.state === 'melting') { saveCubes(); return; }

    el.style.setProperty('--w', entry.geom.w.toFixed(4));
    el.style.setProperty('--ar', entry.geom.ar.toFixed(3));
    el.style.setProperty('--fs', entry.geom.fs.toFixed(4));
    el.style.setProperty('--fsu', fsuFor(entry.geom.fs).toFixed(4));

    var box = currentBox(entry);
    var overlap = cubes.some(function (c) {
      if (c === entry || !c.el) return false;
      var o = currentBox(c);
      var dx = Math.abs(box.x - o.x) - (box.wf + o.wf) / 2;
      var dy = Math.abs(box.y - o.y) - (box.hf + o.hf) / 2;
      return dx < 0.01 && dy < 0.01;
    });

    if (overlap) {
      var pos = findPosition(entry.geom, entry);
      entry.x = pos.x;
      el.style.setProperty('--x', entry.x.toFixed(4));
      if (!entry.surfaced) {
        entry.y = pos.y;
        el.style.setProperty('--y', entry.y.toFixed(4));
      }
      el.style.setProperty('--z', String(zFor(entry)));
    }
    saveCubes();
  }

  /* --------------------------------------------------------------------------
   * 6. 互動：上浮 / 融化 / 重新凝結 / 永久刪除
   * -------------------------------------------------------------------------- */

  /* 上浮完成：把位置交還給 CSS 座標系（--y），並在同一幀清除內聯 transform。
   * 兩次寫入於同一次 style recalc 生效，視覺位置連續，不會跳位。 */
  function commitSurfaced(entry) {
    entry.riseCtx = null;
    entry.raf = null;
    var el = entry.el;
    if (!el || entry.state !== 'rising') return;
    entry.state = 'surfaced';
    entry.surfaced = true;
    entry.y = surfacedY(entry);
    el.style.setProperty('--y', entry.y.toFixed(4));
    el.style.setProperty('--z', String(zFor(entry)));
    el.style.transform = '';               // 與 --y 同一幀生效 → 原子切換
    el.classList.add('surfaced');
    saveCubes();
  }

  /* 第一次點擊：以 rAF「浮力彈簧」模型驅動上浮（欠阻尼彈簧）。
   * - 加速度來自剩餘距離（像浮力），阻力使其接近水面時自然減速；
   * - 欠阻尼帶來非常小的 overshoot / bob，再收斂到穩定位置；
   * - 左右漂移與小幅旋轉以 env(t) 包絡：出發時淡入、接近水面時淡出至 0；
   * - 全程只寫 transform（無 layout reflow），座標連續無跳位。 */
  function riseCube(entry) {
    Sounds.clink();
    entry.state = 'rising';

    var el = entry.el;
    if (!el) return;
    el.style.setProperty('--z', '30');   // 上浮時暫時提到最上層

    if (REDUCED.matches) { commitSurfaced(entry); return; }

    if (entry.raf) cancelAnimationFrame(entry.raf);

    function metrics() {
      var rect = layer.getBoundingClientRect();
      var hPx = (entry.geom.w * rect.width) / entry.geom.ar;
      return { layerH: rect.height, hPx: hPx };
    }

    var m = metrics();
    /* r0：起點中心 → 水面目標中心的距離（px）。
     * CSS 中心位於 entry.y * layerH；目標中心位於 hPx * 0.34（相對圖層頂 = 水面線）。
     * 不設最小位移下限：已在水面目標附近時直接提交，避免強迫位移造成跳位。 */
    var r0 = Math.max(0, entry.y * m.layerH - m.hPx * 0.34);
    if (r0 < 4) { commitSurfaced(entry); return; }

    var ctx = entry.riseCtx = {
      r0: r0, s: 0, v: 0, t: 0,
      w0: rand(3.2, 3.7),                 // 自然頻率（rad/s）→ 整段約 1.3–2 秒
      z: rand(0.76, 0.84),                // 阻尼比：欠阻尼 → 非常小的 overshoot
      ax1: m.hPx * rand(0.05, 0.08) * (Math.random() < 0.5 ? -1 : 1),
      fx1: rand(0.45, 0.65) * Math.PI * 2,
      p1: rand(0, Math.PI * 2),
      ax2: m.hPx * rand(0.015, 0.03) * (Math.random() < 0.5 ? -1 : 1),
      fx2: rand(0.9, 1.4) * Math.PI * 2,
      p2: rand(0, Math.PI * 2),
      rotA: rand(2.2, 4.2) * (Math.random() < 0.5 ? -1 : 1),
      fr: rand(0.5, 0.8) * Math.PI * 2,
      pr: rand(0, Math.PI * 2)
    };

    var last = performance.now();

    function frame(now) {
      if (entry.state !== 'rising' || !entry.el) return;   // 已被刪除 / 中斷
      var dt = clamp((now - last) / 1000, 0.001, 0.032);
      last = now;
      ctx.t += dt;

      var K = ctx.w0 * ctx.w0;
      var C = 2 * ctx.z * ctx.w0;
      var rem = ctx.r0 - ctx.s;               // 剩餘距離（>0 還在目標下方）
      ctx.v += (K * rem - C * ctx.v) * dt;    // 浮力 + 阻力
      ctx.s += ctx.v * dt;

      /* 漂移包絡：出發 0.45s 內淡入；剩餘距離歸零時淡出 → 結束時漂移/旋轉=0 */
      var env = Math.min(1, ctx.t / 0.45) * clamp(rem / ctx.r0, 0, 1);
      var x = (ctx.ax1 * Math.sin(ctx.fx1 * ctx.t + ctx.p1) +
               ctx.ax2 * Math.sin(ctx.fx2 * ctx.t + ctx.p2)) * env;
      var rot = ctx.rotA * Math.sin(ctx.fr * ctx.t + ctx.pr) * env;

      el.style.transform =
        'translate(-50%, -50%) translateY(' + (-ctx.s).toFixed(2) + 'px)' +
        ' translateX(' + x.toFixed(2) + 'px) rotate(' + rot.toFixed(2) + 'deg)';

      var settled = ctx.t > 0.35 &&
                    Math.abs(rem) < Math.max(0.6, ctx.r0 * 0.004) &&
                    Math.abs(ctx.v) < 14;
      if (settled || ctx.t > 2.6) {
        commitSurfaced(entry);                // 同一幀提交 --y 並清除 transform
        return;
      }
      entry.raf = requestAnimationFrame(frame);
    }

    entry.raf = requestAnimationFrame(frame);
  }

  /* 融化完成：移除元素 → 進入 waiting → 排程重新凝結。
   * 若冰塊已被垃圾桶永久刪除（不在 cubes 中），則不再重生。 */
  function meltComplete(entry) {
    if (entry.state !== 'melting') return;
    if (entry.safetyTimer) { clearTimeout(entry.safetyTimer); entry.safetyTimer = null; }
    if (entry.el && entry.el.parentNode) entry.el.remove();
    entry.el = null;
    entry.state = 'waiting';

    if (cubes.indexOf(entry) < 0) return;    // 已被永久刪除 → 不復活

    entry.respawnTimer = setTimeout(function () {
      entry.respawnTimer = null;
      respawnCube(entry);
    }, rand(RESPAWN_MIN, RESPAWN_MAX));
  }

  /* 第二次點擊：融化。只播動畫，不動資料；播完由 meltComplete 排程重生 */
  function meltCube(entry) {
    if (!entry.el) return;
    Sounds.melt();
    entry.state = 'melting';

    var el = entry.el;
    el.style.pointerEvents = 'none';
    el.setAttribute('aria-hidden', 'true');

    var finish = function () { meltComplete(entry); };

    if (REDUCED.matches) {
      entry.safetyTimer = setTimeout(finish, 380);
      return;
    }

    var body = el.querySelector('.cube-body');
    body.classList.add('melting');
    var onEnd = function (ev) {
      if (ev.animationName !== 'melt') return;
      body.removeEventListener('animationend', onEnd);
      finish();
    };
    body.addEventListener('animationend', onEnd);
    entry.safetyTimer = setTimeout(function () {   // 保險：動畫事件未觸發也能收尾
      body.removeEventListener('animationend', onEnd);
      finish();
    }, 1050);                                      // 0.7s 融化動畫 + 緩衝
  }

  /* 融化消失後：同一顆冰塊在水中重新凝結。
   * 保留文字與顏色；surfaced 重設為 false；重新安排水面下的隨機位置。 */
  function respawnCube(entry) {
    if (entry.state !== 'waiting') return;
    entry.state = 'water';
    entry.surfaced = false;
    entry.rot = rand(-3.5, 3.5);
    entry.dur = rand(6, 9.5);          // 重新隨機漂浮相位，像一顆新凝結的冰
    entry.delay = -rand(0, 8);
    var pos = findPosition(entry.geom, entry);   // 水體內、避開現存冰塊
    entry.x = pos.x;
    entry.y = pos.y;
    mountCube(entry, 'reform');        // 柔和 fade-in + 輕微 scale-in（0.65s）
    saveCubes();
  }

  /* 唯一真正的刪除（設定面板垃圾桶）：
   * 取消重生計時器 → 從 cubes 與 localStorage 移除 → 移除 DOM。 */
  function deleteCube(entry) {
    /* 等待重生期間刪除：必須取消計時器，不能讓它稍後復活 */
    if (entry.respawnTimer) { clearTimeout(entry.respawnTimer); entry.respawnTimer = null; }
    /* 上浮動畫中刪除：中斷 rAF */
    if (entry.raf) { cancelAnimationFrame(entry.raf); entry.raf = null; }
    entry.riseCtx = null;

    var i = cubes.indexOf(entry);
    if (i >= 0) cubes.splice(i, 1);
    saveCubes();

    /* 融化動畫播放中：讓它自然播完；
     * meltComplete 會移除元素，且因為已不在 cubes 中而不會排程重生。 */
    if (entry.state === 'melting') return;

    var el = entry.el;
    entry.el = null;
    entry.state = 'dead';
    if (!el) return;

    el.style.pointerEvents = 'none';
    el.setAttribute('aria-hidden', 'true');
    if (REDUCED.matches) { el.remove(); return; }
    el.classList.add('vanish');              // 快速柔和淡出
    setTimeout(function () { if (el.parentNode) el.remove(); }, 260);
  }

  /* 事件委派：所有冰塊點擊集中在圖層處理（狀態機決定行為） */
  layer.addEventListener('click', function (e) {
    var btn = e.target.closest('.ice-cube');
    if (!btn) return;
    var entry = null;
    for (var i = 0; i < cubes.length; i++) {
      if (cubes[i].id === btn.dataset.id) { entry = cubes[i]; break; }
    }
    if (!entry) return;
    if (entry.state === 'water') riseCube(entry);
    else if (entry.state === 'surfaced') meltCube(entry);
    /* rising / melting / waiting：動畫或等待中，忽略點擊 */
  });

  /* --------------------------------------------------------------------------
   * 7. localStorage
   * 保存的是使用者「建立並保留」的冰塊（= cubes 陣列），
   * 與 DOM 是否正在顯示無關：上浮、融化、等待重生都不會寫入刪除。
   * -------------------------------------------------------------------------- */

  function saveCubes() {
    storage.set(KEY_CUBES, cubes.map(function (c) {
      return {
        id: c.id,
        text: c.text,
        color: c.color,
        x: +c.x.toFixed(4),
        y: +c.y.toFixed(4),
        variant: c.variant
      };
    }));
  }

  function loadCubes() {
    var raw = storage.get(KEY_CUBES, []);
    if (!Array.isArray(raw)) return;
    raw.forEach(function (r) {
      if (!r || typeof r.text !== 'string' || !r.id) return;
      var text = r.text.trim().slice(0, MAX_TEXT);
      if (!text) return;
      if (cubes.length >= MAX_CUBES) return;

      var entry = {
        id: String(r.id),
        text: text,
        color: /^#[0-9a-fA-F]{6}$/.test(r.color || '') ? r.color : '#2f5d7c',
        x: clamp(+r.x || 0.5, 0.05, 0.95),
        y: clamp(+r.y || 0.5, 0.05, 0.95),
        rot: rand(-3.5, 3.5),
        variant: clamp(Math.round(+r.variant || 1), 1, 4),
        dur: rand(6, 9.5),
        delay: -rand(0, 8),
        state: 'water',
        surfaced: false,           // 載入時一律從水中開始（生命週期重新循環）
        geom: computeGeometry(text),
        el: null, raf: null, riseCtx: null,
        respawnTimer: null, safetyTimer: null
      };

      /* 位置驗證：超出水體或與已載入的冰塊重疊時重新放置 */
      if (!isPlacementOK(entry)) {
        var pos = findPosition(entry.geom, entry);
        entry.x = pos.x;
        entry.y = pos.y;
      }

      cubes.push(entry);
      mountCube(entry, null);
    });
  }

  /* --------------------------------------------------------------------------
   * 8. 設定面板
   * 清單渲染自 cubes（= 使用者保留的全部冰塊），
   * 融化中 / 等待重生的冰塊也會出現在清單中。
   * -------------------------------------------------------------------------- */

  var dialogApi = {
    fallbackMode: !(typeof dlg.showModal === 'function'),
    open: function () {
      syncSettingsState();
      if (this.fallbackMode) {
        dlg.classList.add('fallback');
        dlg.setAttribute('open', '');
      } else if (!dlg.open) {
        dlg.showModal();
      }
      textIn.focus();
    },
    close: function () {
      if (!this.fallbackMode && dlg.open) dlg.close();
      else dlg.removeAttribute('open');
      openBtn.focus();
    },
    isOpen: function () {
      return this.fallbackMode ? dlg.hasAttribute('open') : dlg.open;
    }
  };

  function syncSettingsState() {
    var full = cubes.length >= MAX_CUBES;
    limitEl.hidden = !full;
    addBtn.disabled = full;
    textIn.disabled = full;
    emptyEl.hidden = cubes.length > 0;
  }

  function renderList() {
    listEl.textContent = '';
    cubes.forEach(function (entry) {
      listEl.appendChild(rowFor(entry));
    });
    syncSettingsState();
  }

  function rowFor(entry) {
    var li = document.createElement('li');
    li.className = 'cube-row';
    li.dataset.id = entry.id;

    /* 文字顏色 */
    var color = document.createElement('input');
    color.type = 'color';
    color.value = entry.color;
    color.setAttribute('aria-label', '冰塊文字顏色');
    color.addEventListener('input', function () {
      entry.color = color.value;
      saveCubes();
      if (!entry.el) return;               // 等待重生中：重生時會套用新顏色
      var txt = entry.el.querySelector('.cube-text');
      txt.style.setProperty('--tc', entry.color);
      var light = isLightColor(entry.color);
      txt.classList.toggle('tc-light', light);
      txt.classList.toggle('tc-dark', !light);
    });

    /* 文字 */
    var input = document.createElement('input');
    input.type = 'text';
    input.maxLength = MAX_TEXT;
    input.value = entry.text;
    input.setAttribute('aria-label', '冰塊文字');
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.addEventListener('input', function () {
      var v = input.value.trim();
      if (!v) return;                       // 清空過程中先不更新
      entry.text = v;
      saveCubes();
      if (!entry.el) return;               // 等待重生中：重生時會套用新文字
      entry.el.querySelector('.cube-text').textContent = v;
      entry.el.setAttribute('aria-label', '冰塊：' + v);
    });
    input.addEventListener('change', function () {
      if (!input.value.trim()) { input.value = entry.text; return; }
      refitCube(entry);                     // 離開欄位時重新計算冰塊尺寸
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') input.blur();  // 手機上按 Enter 收鍵盤
    });

    /* 刪除（唯一真正的刪除：資料 + DOM + localStorage） */
    var del = document.createElement('button');
    del.type = 'button';
    del.className = 'row-del';
    del.setAttribute('aria-label', '刪除這顆冰塊');
    del.innerHTML =
      '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M4 7h16"/><path d="M9 7V5h6v2"/>' +
      '<path d="M7 7l.8 12h8.4L17 7"/><path d="M10 11v5M14 11v5"/></svg>';
    del.addEventListener('click', function () {
      deleteCube(entry);
      li.remove();
      syncSettingsState();
    });

    li.appendChild(color);
    li.appendChild(input);
    li.appendChild(del);
    return li;
  }

  /* 新增表單 */
  addForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = textIn.value.trim().slice(0, MAX_TEXT);
    if (!text || cubes.length >= MAX_CUBES) return;
    if (addCube(text, colorIn.value)) {
      textIn.value = '';
      renderList();
      textIn.focus();
    }
  });

  /* 色票快速選擇 */
  Array.prototype.forEach.call(document.querySelectorAll('.swatch'), function (sw) {
    sw.addEventListener('click', function () {
      colorIn.value = sw.dataset.color;
      Array.prototype.forEach.call(document.querySelectorAll('.swatch'), function (s) {
        s.classList.toggle('is-active', s === sw);
      });
    });
  });
  colorIn.addEventListener('input', function () {
    Array.prototype.forEach.call(document.querySelectorAll('.swatch'), function (s) {
      s.classList.remove('is-active');
    });
  });

  /* 開 / 關面板 */
  openBtn.addEventListener('click', function () { dialogApi.open(); });
  closeBtn.addEventListener('click', function () { dialogApi.close(); });
  dlg.addEventListener('close', function () { openBtn.focus(); });

  /* 點擊背景關閉（原生 dialog 的 backdrop） */
  dlg.addEventListener('click', function (e) {
    if (e.target === dlg) dialogApi.close();
  });

  /* fallback 模式：點擊面板以外區域關閉 */
  document.addEventListener('click', function (e) {
    if (!dialogApi.fallbackMode || !dialogApi.isOpen()) return;
    if (!dlg.contains(e.target) && !openBtn.contains(e.target)) dialogApi.close();
  });

  /* --------------------------------------------------------------------------
   * 9. 音效：Web Audio API 程序化合成（無外部檔案、無版權疑慮）
   *    - ambient：低頻過濾噪聲循環 + 緩慢 LFO，像安靜的水聲房間底噪
   *    - clink  ：兩次短促的高頻泛音敲擊 + 低頻短促碰觸（冰塊碰撞）
   *    - melt   ：向下掃頻的柔和噪聲 + 水滴音 + 低頻柔波（融化 / 消失）
   *
   *    iOS Safari 解鎖流程（實機修正重點）：
   *    a. AudioContext 只在使用者手勢的同步 call stack 中建立；
   *       pointerdown / touchend / click / keydown 全部監聽
   *       （舊 iOS Safari 最可靠的是 touchend）。
   *    b. state 為 suspended 或 interrupted（iOS 特有）都再次 resume()。
   *    c. 手勢內先播放一個極短的靜音 buffer（解鎖樣本），
   *       替頁面啟用 iOS 音訊 session。
   *    d. clink / melt 一律經 whenRunning()：context 尚未 running 時，
   *       等「同一手勢內啟動的 resume()」完成後才排程——
   *       避免 iOS Safari 把 suspended 期間排程的聲音整批丟棄。
   *    e. ambient 初始化失敗不影響 clink / melt；
   *       所有節點都接往 master → audioContext.destination。
   *    f. 不偵測 sound enabled = true 就假設聲音已啟動——
   *       播放前一律以 AudioContext.state 為準。
   * -------------------------------------------------------------------------- */

  var Sounds = {
    ctx: null,
    master: null,
    ambientGain: null,
    started: false,
    unlocked: false,
    enabled: storage.get(KEY_SOUND, true) !== false,

    /* iOS Safari 特有：除了 'suspended' 還可能出現 'interrupted'
     * （來電、Siri、切換分頁）。兩種狀態都需要再次 resume。 */
    needsResume: function () {
      if (!this.ctx) return false;
      return this.ctx.state === 'suspended' || this.ctx.state === 'interrupted';
    },

    /* 只能在 user gesture 的同步 call stack 中被呼叫（建立 context） */
    ensure: function () {
      if (!this.ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        try { this.ctx = new AC(); } catch (e) { return false; }
        this.master = this.ctx.createGain();
        this.master.gain.value = this.enabled ? 0.8 : 0.0001;
        this.master.connect(this.ctx.destination);   // 唯一輸出口
        /* ambient 失敗不允許連帶讓 clink / melt 失效 */
        try { this.buildAmbient(); } catch (e) { this.ambientGain = null; }
      }
      if (this.needsResume()) this.resumeNow();
      if (!this.unlocked) this.playUnlockSample();
      return true;
    },

    /* 同步呼叫 resume()（務必發生在手勢 call stack 內）；
     * 回傳 Promise<boolean>：true 代表 context 現在已是 running */
    resumeNow: function () {
      if (!this.ctx) return Promise.resolve(false);
      var self = this;
      var p;
      try { p = this.ctx.resume(); } catch (e) { return Promise.resolve(false); }
      return Promise.resolve(p)
        .catch(function () { return false; })
        .then(function () {
          return !!(self.ctx && self.ctx.state === 'running');
        });
    },

    /* 經典 iOS 解鎖樣式：在手勢內播放一個極短的靜音 buffer，
     * 替頁面啟用 iOS 音訊 session（實機 Safari 必要） */
    playUnlockSample: function () {
      try {
        var ctx = this.ctx;
        var buf = ctx.createBuffer(
          1, Math.max(1, Math.floor(ctx.sampleRate * 0.02)), ctx.sampleRate);
        var src = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(ctx.destination);
        src.start(0);
        this.unlocked = true;
      } catch (e) { /* 解鎖樣本失敗不影響後續流程 */ }
    },

    /* 播放入口：已 running → 直接排程；尚未 running → 等同一手勢內
     * 啟動的 resume() 完成後再排程，避免 iOS 丟棄 suspended 期間的音 */
    whenRunning: function (fn) {
      var self = this;
      if (!this.ctx) return;
      if (this.ctx.state === 'running') { fn(); return; }
      this.resumeNow().then(function (ok) { if (ok) fn(); });
    },

    buildAmbient: function () {
      var ctx = this.ctx;
      var len = Math.floor(ctx.sampleRate * 3);
      var buf = ctx.createBuffer(1, len, ctx.sampleRate);
      var data = buf.getChannelData(0);
      var last = 0;
      for (var i = 0; i < len; i++) {
        var white = Math.random() * 2 - 1;
        last = 0.98 * last + 0.02 * white;      // brown-ish noise
        data[i] = last * 3.2;
      }

      var src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;

      var lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 260;
      lp.Q.value = 0.4;

      this.ambientGain = ctx.createGain();
      this.ambientGain.gain.value = 0.0001;

      /* 緩慢的滤波起伏，讓底噪有「水」的呼吸感 */
      var lfo = ctx.createOscillator();
      lfo.frequency.value = 0.07;
      var lfoGain = ctx.createGain();
      lfoGain.gain.value = 90;
      lfo.connect(lfoGain);
      lfoGain.connect(lp.frequency);

      src.connect(lp);
      lp.connect(this.ambientGain);
      this.ambientGain.connect(this.master);
      src.start();
      lfo.start();
    },

    startAmbient: function () {
      if (!this.enabled || !this.ensure() || this.started) return;
      var self = this;
      this.whenRunning(function () {
        self.started = true;
        if (!self.ambientGain) return;
        var t = self.ctx.currentTime;
        var g = self.ambientGain.gain;
        g.cancelScheduledValues(t);
        g.setValueAtTime(0.0001, t);
        g.exponentialRampToValueAtTime(0.05, t + 4);   // 4 秒淡入，不干擾
      });
    },

    /* 短噪聲爆發（打擊瞬間的質感） */
    noiseBurst: function (t0, dur, freq, vol) {
      var ctx = this.ctx;
      var len = Math.max(1, Math.floor(ctx.sampleRate * dur));
      var buf = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      }
      var src = ctx.createBufferSource();
      src.buffer = buf;
      var f = ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = freq;
      var g = ctx.createGain();
      g.gain.value = vol;
      src.connect(f);
      f.connect(g);
      g.connect(this.master);
      src.start(t0);
    },

    clink: function () {
      if (!this.enabled || !this.ensure()) return;
      var self = this;
      this.whenRunning(function () { self.playClink(); });
    },

    playClink: function () {
      var ctx = this.ctx;
      var self = this;
      var t = ctx.currentTime;

      var strike = function (t0, vol) {
        [1730, 2520, 3410, 5230].forEach(function (base, i) {
          var o = ctx.createOscillator();
          o.type = 'sine';
          o.frequency.value = base * rand(0.97, 1.03);
          var g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, t0);
          g.gain.exponentialRampToValueAtTime(vol / (i + 1.5), t0 + 0.006);
          g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.1 + i * 0.045);
          o.connect(g);
          g.connect(self.master);
          o.start(t0);
          o.stop(t0 + 0.32);
        });
        self.noiseBurst(t0, 0.03, 3000, vol * 0.5);
      };

      strike(t, 0.16);
      strike(t + rand(0.05, 0.09), 0.07);        // 第二聲輕碰

      var o = ctx.createOscillator();             // 冰塊本體的短促低頻
      o.type = 'sine';
      o.frequency.setValueAtTime(210, t);
      o.frequency.exponentialRampToValueAtTime(120, t + 0.09);
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.05, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
      o.connect(g);
      g.connect(this.master);
      o.start(t);
      o.stop(t + 0.2);
    },

    melt: function () {
      if (!this.enabled || !this.ensure()) return;
      var self = this;
      this.whenRunning(function () { self.playMelt(); });
    },

    playMelt: function () {
      var ctx = this.ctx;
      var t = ctx.currentTime;

      /* 柔和的向下掃頻水聲 */
      var len = Math.floor(ctx.sampleRate * 0.5);
      var buf = ctx.createBuffer(1, len, ctx.sampleRate);
      var d = buf.getChannelData(0);
      for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      var src = ctx.createBufferSource();
      src.buffer = buf;
      var bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 1.4;
      bp.frequency.setValueAtTime(1350, t);
      bp.frequency.exponentialRampToValueAtTime(330, t + 0.45);
      var g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.09, t + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      src.connect(bp);
      bp.connect(g);
      g.connect(this.master);
      src.start(t);
      src.stop(t + 0.55);

      /* 水滴「噗通」 */
      var o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(820, t + 0.24);
      o.frequency.exponentialRampToValueAtTime(300, t + 0.37);
      var og = ctx.createGain();
      og.gain.setValueAtTime(0.0001, t + 0.24);
      og.gain.exponentialRampToValueAtTime(0.06, t + 0.27);
      og.gain.exponentialRampToValueAtTime(0.0001, t + 0.42);
      o.connect(og);
      og.connect(this.master);
      o.start(t + 0.24);
      o.stop(t + 0.45);

      /* 低頻柔波收尾 */
      var b = ctx.createOscillator();
      b.type = 'sine';
      b.frequency.setValueAtTime(150, t);
      b.frequency.exponentialRampToValueAtTime(92, t + 0.5);
      var bg = ctx.createGain();
      bg.gain.setValueAtTime(0.0001, t);
      bg.gain.exponentialRampToValueAtTime(0.04, t + 0.04);
      bg.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
      b.connect(bg);
      bg.connect(this.master);
      b.start(t);
      b.stop(t + 0.6);
    },

    setEnabled: function (on) {
      this.enabled = on;
      storage.set(KEY_SOUND, on);
      /* 第一次開啟聲音也是在使用者手勢內：順便建立 / 解鎖 context */
      if (!this.ctx) {
        if (on) { this.ensure(); this.startAmbient(); }
        return;
      }
      var t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(on ? 0.8 : 0.0001, t, 0.12);
      if (on) this.startAmbient();
    }
  };

  /* 瀏覽器 autoplay 限制：第一次互動才建立 / 恢復 AudioContext 並啟動環境音。
   * 手勢類型全面覆蓋：pointerdown（現代瀏覽器）、touchend（舊 iOS 最可靠）、
   * click、keydown；ensure() 幂等，重複觸發無副作用。 */
  function unlockAudio() {
    if (Sounds.ensure() && Sounds.enabled) Sounds.startAmbient();
  }
  document.addEventListener('pointerdown', unlockAudio, true);
  document.addEventListener('touchend', unlockAudio, true);
  document.addEventListener('click', unlockAudio, true);
  document.addEventListener('keydown', unlockAudio, true);

  /* iOS：切回前景時 context 可能停在 interrupted / suspended；
   * 立即嘗試恢復一次，失敗也無妨——下一次手勢仍會再 resume。 */
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && Sounds.ctx && Sounds.needsResume()) {
      Sounds.resumeNow();
    }
  });

  function applySoundUI() {
    soundBtn.setAttribute('aria-pressed', String(Sounds.enabled));
    soundBtn.classList.toggle('is-off', !Sounds.enabled);
  }
  soundBtn.addEventListener('click', function () {
    Sounds.setEnabled(!Sounds.enabled);
    if (Sounds.enabled) Sounds.startAmbient();
    applySoundUI();
  });

  /* --------------------------------------------------------------------------
   * 10. 事件繫結與初始化
   * -------------------------------------------------------------------------- */

  /* 視窗尺寸改變時，重新校正上浮中冰塊的目標距離。
   * 已移動的位移 s 是 px 值仍連續；彈簧會平滑地把冰塊帶到新目標。 */
  window.addEventListener('resize', function () {
    cubes.forEach(function (c) {
      if (c.state !== 'rising' || !c.riseCtx) return;
      var rect = layer.getBoundingClientRect();
      var hPx = (c.geom.w * rect.width) / c.geom.ar;
      c.riseCtx.r0 = Math.max(0, c.y * rect.height - hPx * 0.34);
    });
  });

  /* 長按右鍵選單干擾冰塊操作時予以阻擋 */
  $('#stage').addEventListener('contextmenu', function (e) { e.preventDefault(); });

  loadCubes();
  renderList();
  applySoundUI();

  if (!storage.ok) {
    console.warn('[文字冰塊] 無法使用 localStorage，資料將不會在重新整理後保留。');
  }

})();
