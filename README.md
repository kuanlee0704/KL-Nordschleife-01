# RC4WD 4WD 遙控車模擬器

電腦開 `sim.html`（3D 車 + 重寫自 `pico/main.py` 的控制邏輯 + 物理），手機開 `controller.html`
（你原本 `esp32/index.html` 的介面，只把 WebSocket 換成 WebRTC），兩邊用 PeerJS 配對後點對點直連。

## 部署到 GitHub Pages
1. 新增 repo，把這個資料夾的全部檔案（含 `js/`）放到根目錄 push 上去
2. Settings → Pages → Branch 選 `main` / `(root)` → Save
3. 約 1 分鐘後 `https://<帳號>.github.io/<repo>/` 即可使用

## 使用
電腦開 `sim.html` → 手機掃 QR → 手機橫放操作。沒手機時鍵盤：W/S 油門、A/D 轉向、Space 放油門、M 切模式、O 避障、1/2/3 或 C 切視角、R 重置。

## 紐北賽車遊戲 + 手機遙控
`nordschleife.html` 與 `sim.html` 用同一套遙控協定：開遊戲 → 首頁「📱 手機遙控」分頁 → 手機掃 QR（或開 `controller.html` 輸入 6 碼）。
手機：油門往上推、拉到中立以下＝煞車（停車後倒車）、方向拖曳；連到遊戲時手機改顯示即時數據（車速、轉速、檔位、油門/煞車、G 值、圈速），並多一顆「🤖 自動駕駛」按鈕（比賽中才有效，一碰油門/煞車/方向就接手）。設定裡有「倒車鎖定保護」開關：開啟時，在行進中踩煞車停下後不會自動變倒車，要放開再拉才倒車。遊戲端不傳鏡頭畫面。
鍵盤、手把仍可同時使用；手機連線時切視窗不會自動暫停。
第一次開啟會直接停在該分頁（`?rc=1` 可強制）；遙控器網頁不在同一資料夾時，可在面板裡改網址。

## 檔案
- `js/sim-core.js`：Pico 邏輯移植 + 底盤物理 + 場地（無 DOM，可在 Node 測）
- `js/net.js`：PeerJS 載入與連線碼
- 外部函式庫走 CDN：three.js r128、qrcodejs、PeerJS 1.5.4（配對用公用 broker `0.peerjs.com`）

## 注意
- 手機與電腦在同一個 Wi-Fi 最穩；跨網路（手機 4G）可能因 NAT 連不上（只配 STUN，沒有 TURN）
- 物理參數（質量、摩擦、馬達扭矩）是估的，用來「看起來合理」，不能取代實車調 PID

## 模擬器 ⇄ 韌體 同步
手機介面的唯一來源是韌體包裡的 `esp32/index.html`；`controller.html` 只是把它的 WebSocket 換成 WebRTC。
模擬器右上角「網路」選單可模擬 Wi-Fi 延遲/抖動/卡頓，用來看延遲數值與失控保護（300 ms）的表現。

模擬器也有電池模型（2200mAh 3S、內阻壓降、隨耗電下降），右上角「電池」選單可設定剩餘電量或模擬沒接電量計；電壓下垂會讓車子變慢。
