# 文字冰塊 · Text Ice Glass

一杯清水，與你自己建立的文字冰塊。點一下，冰塊上浮到水面；再點一下，它安靜地融化消失。

一個極簡、安靜的互動網頁。純 **HTML + CSS + Vanilla JavaScript**，零依賴、零建置、零後端，可直接部署到 GitHub Pages。

> 網站本身不預設任何文字，也不解釋文字的意義。所有冰塊上的文字都由你自己輸入。

---

## 功能

- **建立文字冰塊**：輸入任意文字（最長 24 字）、選擇文字顏色（6 色票 + 自訂選色器）
- **兩段式互動**：第一次點擊 → 冰塊自然上浮到水面（含左右擺動與減速）；第二次點擊 → 縮小、淡化、融化消失
- **冰塊外觀**：半透明冰晶質感（CSS 漸層 + 陰影，無外部圖片），每顆形狀、角度、切面皆隨機略有差異；依文字長度自動調整尺寸，並自動避免互相重疊
- **音效**：全部由 Web Audio API 即時合成（環境水聲底噪 / 冰塊碰撞 / 融化水滴），無版權疑慮；遵守瀏覽器 autoplay 政策，於第一次互動後才啟動；右下角提供低調的聲音開關
- **資料保存**：冰塊文字、顏色、位置、聲音設定皆存於 `localStorage`，重新整理後仍在；已融化的冰塊不會復活
- **Responsive**：`100dvh`、`clamp()`、`aspect-ratio`、`safe-area-inset`，支援 iPhone / Android 手機 / 平板 / 桌機、直向與橫向，不出現多餘捲軸
- **觸控優化**：Pointer / touch 事件處理、防止 double-tap 異常、防止選字與拖動、44px 觸控目標、iOS Safari 相容
- **無障礙**：冰塊為原生 `<button>`（可鍵盤操作）、語意化 HTML、原生 `<dialog>` 焦點管理、`prefers-reduced-motion` 支援

## 檔案結構

```
/
├── index.html        # 主頁面（語意化結構 + 設定面板）
├── style.css         # 所有視覺與動畫（CSS variables 管理）
├── app.js            # 全部邏輯（冰塊、動畫、儲存、音效）
├── README.md
└── sounds/
    └── README.md     # 音效說明與替換指南
```

## 本機預覽

直接用瀏覽器開啟 `index.html` 即可基本運作（無需伺服器）。

或啟動本地伺服器（推薦，行為與線上一致）：

```bash
# 任選一種
python3 -m http.server 8000
npx serve .
```

然後打開 `http://localhost:8000`。

## 部署到 GitHub Pages（Deploy from a branch）

1. 在 GitHub 建立一個新 repository（例如 `text-ice-glass`）。
2. 將以下檔案上傳到 repository **根目錄**（根目錄一定要有 `index.html`）：
   - `index.html`、`style.css`、`app.js`、`README.md`、`sounds/` 資料夾
3. 進入 repository 的 **Settings → Pages**。
4. 在 **Build and deployment → Source** 選擇 **Deploy from a branch**。
5. **Branch** 選 `main`、資料夾選 **/ (root)**，按 **Save**。
6. 等待 1–2 分鐘，訪問：
   `https://<你的使用者名稱>.github.io/<repository名稱>/`

不需要 `npm install`、不需要 build、不需要任何環境變數或 API key。

> 所有資源連結皆為相對路徑（`style.css`、`app.js`），因此部署在 project site 子路徑（`/repo-name/`）下也能正常運作。

## 自訂

| 想改什麼 | 位置 |
|---|---|
| 水面高度、玻璃尺寸範圍 | `style.css` 的 `:root` 中 `--surface-frac`、`--u` |
| 主色、邊框色 | `style.css` 的 `--accent`、`--glass-line` |
| 冰塊數量上限 | `app.js` 的 `MAX_CUBES`（預設 14） |
| 文字長度上限 | `app.js` 的 `MAX_TEXT` 與 `index.html` 的 `maxlength` |
| 預設色票 | `index.html` 的 `.swatch` 元素 |
| 音效 | 見 `sounds/README.md`（目前為 Web Audio 合成，可替換為音檔） |

## 資料儲存

全部只存在瀏覽器的 `localStorage`，沒有帳號、伺服器、資料庫或任何網路請求：

| Key | 內容 |
|---|---|
| `iceGlass.cubes.v1` | 冰塊清單（id、文字、顏色、位置、角度、外觀變體、是否浮於水面） |
| `iceGlass.sound.v1` | 聲音開關 |

清除瀏覽器資料或使用無痕模式時，資料不會保留。

## 瀏覽器支援

- Chrome / Edge / Firefox / Safari（含 iOS Safari 15.4+、Android Chrome）最新兩個大版本
- 舊瀏覽器的基本 fallback：不支援 `<dialog>` 時以 overlay 呈現設定面板；不支援 container query 單位時以 `--u` 基準字級呈現；不支援 `100dvh` 時退回 `100vh`
- 開啟「減少動態效果」（prefers-reduced-motion）時，自動停用晃動與水面動畫，互動改為最短路徑

## 授權

MIT License — 可自由修改與部署。
