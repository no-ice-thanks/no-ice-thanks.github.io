/* ==========================================================================
   文字冰塊 — app.js
   Vanilla JavaScript，無任何依賴。以 IIFE 封裝，不污染全域。

   模組順序：
   1. 工具函式與安全儲存層
   2. DOM 參照與狀態
   3. 幾何計算（文字 → 冰塊尺寸/字級/比例）
   4. 冰塊元素產生與掛載
   5. 放置演算法（防重疊）
   6. 互動：第一次點擊上浮（WAAPI）/ 第二次點擊融化（CSS）
   7. localStorage 存取
   8. 設定面板（原生 dialog + fallback）
   9. 音效（Web Audio API 程序化合成，無外部音檔、無版權問題）
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
  var MAX_CUBES = 14;   // 杯子容量上限，避免過度擁擠
  var MAX_TEXT = 24;    // 與 input maxlength 一致

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

  /* cubes：目前存在杯中的冰塊
   * entry = { id, text, color, x, y, rot, variant, dur, delay,
   *           surfaced, locked, geom:{w,fs,ar}, el } */
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

  function mountCube(entry, animateIn) {
    var el = cubeElement(entry);
    entry.el = el;
    if (entry.surfaced) el.classList.add('surfaced');
    layer.appendChild(el);
    if (animateIn && !REDUCED.matches) {
      el.classList.add('enter');
      setTimeout(function () { el.classList.remove('enter'); }, 650);
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

  /* 冰塊目前在圖層分數座標系的 AABB */
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

    var others = cubes
      .filter(function (c) { return c !== excludeEntry; })
      .map(currentBox);

    var best = null, bestScore = -Infinity;
    for (var i = 0; i < 140; i++) {
      var x = rand(minX, maxX);
      var y = rand(minY, maxY);
      var score = Infinity;
      for (var j = 0; j < others.length; j++) {
        var o = others[j];
        var dx = Math.abs(x - o.x) - (geom.w + o.wf) / 2;
        var dy = Math.abs(y - o.y) - (hf + o.hf) / 2;
        score = Math.min(score, dx, dy);
      }
      if (score > 0.014) return { x: x, y: y };   // 找到不重疊的位置
      if (score > bestScore) { bestScore = score; best = { x: x, y: y }; }
    }
    return best || { x: rand(minX, maxX), y: rand(minY, maxY) };
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
      surfaced: false,
      locked: false,
      geom: geom
    };
    cubes.push(entry);
    mountCube(entry, true);
    saveCubes();
    return true;
  }

  /* 文字修改後重新計算尺寸；若因此與鄰近冰塊重疊則重新找位置 */
  function refitCube(entry) {
    entry.geom = computeGeometry(entry.text);
    var el = entry.el;
    el.style.setProperty('--w', entry.geom.w.toFixed(4));
    el.style.setProperty('--ar', entry.geom.ar.toFixed(3));
    el.style.setProperty('--fs', entry.geom.fs.toFixed(4));
    el.style.setProperty('--fsu', fsuFor(entry.geom.fs).toFixed(4));

    var box = currentBox(entry);
    var overlap = cubes.some(function (c) {
      if (c === entry) return false;
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
   * 6. 互動：上浮與融化
   * -------------------------------------------------------------------------- */

  /* 第一次點擊：多段關鍵影格上浮（加速 → 左右擺動 → 減速 → 停在水面） */
  function riseCube(entry) {
    var el = entry.el;
    Sounds.clink();

    var rect = layer.getBoundingClientRect();
    var hPx = (entry.geom.w * rect.width) / entry.geom.ar;
    var targetCenterY = rect.top + hPx * 0.34;

    var cubeRect = el.getBoundingClientRect();
    var curCenterY = cubeRect.top + cubeRect.height / 2;
    var d = Math.max(0, curCenterY - targetCenterY);

    var sway1 = hPx * rand(0.05, 0.09) * (Math.random() < 0.5 ? -1 : 1);
    var sway2 = -sway1 * 0.55;
    var rot1 = rand(2, 4) * (sway1 < 0 ? -1 : 1);
    var rot2 = -rot1 * 0.5;

    el.style.setProperty('--z', '30');   // 上浮時暫時提到最上層

    var anim;
    if (REDUCED.matches) {
      anim = el.animate(
        [
          { transform: 'translate(-50%, -50%) translateY(0px)' },
          { transform: 'translate(-50%, -50%) translateY(' + (-d) + 'px)' }
        ],
        { duration: 320, easing: 'ease-out', fill: 'forwards' }
      );
    } else {
      anim = el.animate(
        [
          {
            transform: 'translate(-50%, -50%) translateY(0px) translateX(0px) rotate(0deg)',
            easing: 'cubic-bezier(0.4, 0.1, 0.55, 0.9)'
          },
          {
            transform: 'translate(-50%, -50%) translateY(' + (-d * 0.55).toFixed(1) + 'px)' +
                       ' translateX(' + sway1.toFixed(1) + 'px) rotate(' + rot1.toFixed(2) + 'deg)',
            offset: 0.48,
            easing: 'cubic-bezier(0.35, 0.15, 0.4, 1)'
          },
          {
            transform: 'translate(-50%, -50%) translateY(' + (-d * 0.92).toFixed(1) + 'px)' +
                       ' translateX(' + sway2.toFixed(1) + 'px) rotate(' + rot2.toFixed(2) + 'deg)',
            offset: 0.8,
            easing: 'cubic-bezier(0.3, 0.25, 0.3, 1)'
          },
          {
            transform: 'translate(-50%, -50%) translateY(' + (-d).toFixed(1) + 'px)' +
                       ' translateX(0px) rotate(0deg)'
          }
        ],
        { duration: 1500 + Math.random() * 500, fill: 'forwards' }
      );
    }

    anim.onfinish = function () {
      entry.surfaced = true;
      entry.y = surfacedY(entry);
      el.style.setProperty('--y', entry.y.toFixed(4));
      el.style.setProperty('--z', String(zFor(entry)));
      el.classList.add('surfaced');
      anim.cancel();          // 移除 fill；定位交回 top 百分比（resize 後依然正確）
      entry.locked = false;
      saveCubes();
    };
  }

  /* 從狀態與 localStorage 移除（融化動畫開始前就移除，重新整理也不會復活） */
  function removeCube(entry) {
    var i = cubes.indexOf(entry);
    if (i >= 0) cubes.splice(i, 1);
    saveCubes();
  }

  /* 第二次點擊：融化。silent = 從設定面板刪除時不播聲音 */
  function meltCube(entry, silent) {
    if (!silent) Sounds.melt();
    removeCube(entry);

    var el = entry.el;
    el.style.pointerEvents = 'none';
    el.setAttribute('aria-hidden', 'true');
    el.classList.remove('enter');

    var finish = function () { if (el.parentNode) el.remove(); };

    if (REDUCED.matches) {
      setTimeout(finish, 400);
    } else {
      var body = el.querySelector('.cube-body');
      body.classList.add('melting');
      var onEnd = function (ev) {
        if (ev.animationName === 'melt') {
          body.removeEventListener('animationend', onEnd);
          finish();
        }
      };
      body.addEventListener('animationend', onEnd);
      setTimeout(finish, 1800);   // 保險：動畫事件未觸發也能移除
    }
  }

  /* 事件委派：所有冰塊點擊集中在圖層處理 */
  layer.addEventListener('click', function (e) {
    var btn = e.target.closest('.ice-cube');
    if (!btn) return;
    var entry = null;
    for (var i = 0; i < cubes.length; i++) {
      if (cubes[i].id === btn.dataset.id) { entry = cubes[i]; break; }
    }
    if (!entry || entry.locked) return;
    if (!entry.surfaced) {
      entry.locked = true;
      riseCube(entry);
    } else {
      meltCube(entry, false);
    }
  });

  /* --------------------------------------------------------------------------
   * 7. localStorage
   * -------------------------------------------------------------------------- */

  function saveCubes() {
    storage.set(KEY_CUBES, cubes.map(function (c) {
      return {
        id: c.id,
        text: c.text,
        color: c.color,
        x: +c.x.toFixed(4),
        y: +c.y.toFixed(4),
        rot: +c.rot.toFixed(2),
        variant: c.variant,
        surfaced: c.surfaced
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
      var entry = {
        id: String(r.id),
        text: text,
        color: /^#[0-9a-fA-F]{6}$/.test(r.color || '') ? r.color : '#2f5d7c',
        x: clamp(+r.x || 0.5, 0.05, 0.95),
        y: clamp(+r.y || 0.5, 0.05, 0.95),
        rot: clamp(+r.rot || 0, -6, 6),
        variant: clamp(Math.round(+r.variant || 1), 1, 4),
        dur: rand(6, 9.5),
        delay: -rand(0, 8),
        surfaced: !!r.surfaced,
        locked: false,
        geom: computeGeometry(text)
      };
      cubes.push(entry);
      mountCube(entry, false);
    });
  }

  /* --------------------------------------------------------------------------
   * 8. 設定面板
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
      var txt = entry.el.querySelector('.cube-text');
      txt.style.setProperty('--tc', entry.color);
      var light = isLightColor(entry.color);
      txt.classList.toggle('tc-light', light);
      txt.classList.toggle('tc-dark', !light);
      saveCubes();
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
      entry.el.querySelector('.cube-text').textContent = v;
      entry.el.setAttribute('aria-label', '冰塊：' + v);
      saveCubes();
    });
    input.addEventListener('change', function () {
      if (!input.value.trim()) { input.value = entry.text; return; }
      refitCube(entry);                     // 離開欄位時重新計算冰塊尺寸
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') input.blur();  // 手機上按 Enter 收鍵盤
    });

    /* 刪除 */
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
      meltCube(entry, true);                // 靜靜地融化，不播聲音
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
   * -------------------------------------------------------------------------- */

  var Sounds = {
    ctx: null,
    master: null,
    ambientGain: null,
    started: false,
    enabled: storage.get(KEY_SOUND, true) !== false,

    ensure: function () {
      if (!this.ctx) {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.enabled ? 0.8 : 0.0001;
        this.master.connect(this.ctx.destination);
        this.buildAmbient();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return true;
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
      this.started = true;
      var t = this.ctx.currentTime;
      var g = this.ambientGain.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(0.0001, t);
      g.exponentialRampToValueAtTime(0.05, t + 4);   // 4 秒淡入，不干擾
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
      if (!this.ctx) return;
      var t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(on ? 0.8 : 0.0001, t, 0.12);
    }
  };

  /* 瀏覽器 autoplay 限制：第一次互動才建立 / 恢復 AudioContext 並啟動環境音 */
  function unlockAudio() {
    if (Sounds.ensure() && Sounds.enabled) Sounds.startAmbient();
  }
  document.addEventListener('pointerdown', unlockAudio, true);
  document.addEventListener('keydown', unlockAudio, true);

  function applySoundUI() {
    soundBtn.setAttribute('aria-pressed', String(Sounds.enabled));
    soundBtn.classList.toggle('is-off', !Sounds.enabled);
  }
  soundBtn.addEventListener('click', function () {
    Sounds.setEnabled(!Sounds.enabled);
    if (Sounds.enabled) Sounds.startAmbient();
    applySoundUI();
  });

  /* 長按右鍵選單干擾冰塊操作時予以阻擋 */
  $('#stage').addEventListener('contextmenu', function (e) { e.preventDefault(); });

  /* --------------------------------------------------------------------------
   * 10. 初始化
   * -------------------------------------------------------------------------- */

  loadCubes();
  renderList();
  applySoundUI();

  if (!storage.ok) {
    console.warn('[文字冰塊] 無法使用 localStorage，資料將不會在重新整理後保留。');
  }

})();
