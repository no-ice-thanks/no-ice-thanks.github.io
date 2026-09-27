# sounds/ — 音效說明與替換位置

## 目前的實作

第一版的全部音效**不需要任何音訊檔**。`app.js` 中的 `Sounds` 物件使用
**Web Audio API** 即時合成三種聲音：

| 音效 | 觸發時機 | 合成方式 |
|---|---|---|
| 環境音 | 使用者第一次與頁面互動後淡入 | 低頻濾波噪聲循環 + 緩慢 LFO |
| 冰塊碰撞 | 第一次點擊冰塊 | 高頻正弦泛音疊加 + 短噪聲爆發 + 低頻本體音 |
| 融化消失 | 第二次點擊冰塊 | 向下掃頻帶通噪聲 + 水滴下滑音 + 低頻柔波 |

這些聲音皆為程式即時產生，**沒有版權疑慮**。

## 如何替換成自己的音檔

1. 將音檔放進這個資料夾，建議檔名：
   - `ambient.mp3`（或 `.ogg`）— 環境音，建議 10–30 秒、可無縫循環、音量低
   - `clink.mp3` — 冰塊碰撞（短，< 0.5 秒）
   - `melt.mp3` — 柔和的融化 / 水滴聲（< 1.5 秒）
2. 修改 `app.js` 的 `Sounds` 物件，把對應方法改為播放音檔，例如：

```js
// 於 Sounds 物件內預載（在 ensure() 之後或頁面閒置時）：
// var audio = new Audio('sounds/clink.mp3');

clink: function () {
  if (!this.enabled) return;
  audio.currentTime = 0;
  audio.play();
},
```

3. 若需要循環的環境音，可使用：

```js
ambientAudio.loop = true;
ambientAudio.volume = 0.15;
ambientAudio.play();   // 同樣必須在使用者第一次互動後呼叫
```

## 注意事項

- 請只使用**你擁有版權或已獲授權**的音源（例如 CC0 / 公有領域素材），
  不要複製其他 App 的聲音。
- 瀏覽器 autoplay 政策：任何聲音（含 `<audio>` 與 Web Audio）都必須在
  使用者第一次互動（pointerdown / keydown）之後才能播放。
  本專案已在 `app.js` 的 `unlockAudio()` 處理此邏輯，替換音檔時請保留。
- 音檔請保持小體積（建議單檔 < 200KB），並可同時提供 `.ogg` 備援。
