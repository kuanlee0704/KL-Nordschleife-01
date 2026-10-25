/* 連線小工具：PeerJS 載入 (jsDelivr → unpkg 備援)、連線碼、URL 參數
 * 配對走 PeerJS 公用 broker (只交換 WebRTC 握手資訊)，之後手機 ⇄ 電腦是點對點直連。
 * 想用自己的 broker: 在網址後加 ?ph=主機&pp=埠&ps=1(https)&pk=金鑰&pa=路徑 */
(function () {
  'use strict';
  const SRC = [
    'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js',
    'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
  ];
  const PREFIX = 'rc4wd-';
  const ALPHA = 'abcdefghjkmnpqrstuvwxyz23456789';      // 去掉易混淆字元 (i l o 0 1)

  function loadScript(u) {
    return new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = u; s.onload = res; s.onerror = () => rej(new Error('load ' + u));
      document.head.appendChild(s);
    });
  }
  async function loadPeer() {
    if (window.Peer) return window.Peer;
    for (const u of SRC) { try { await loadScript(u); if (window.Peer) return window.Peer; } catch (e) { /* 試下一個 */ } }
    throw new Error('無法載入 PeerJS 函式庫');
  }
  function param(name) {
    const m = new RegExp('[?&#]' + name + '=([^&#]*)').exec(location.search + location.hash);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function peerOptions() {
    const o = { debug: 1 };
    const h = param('ph'); if (h) {
      o.host = h; o.port = +(param('pp') || 443); o.secure = param('ps') !== '0'; o.path = param('pa') || '/';
      const k = param('pk'); if (k) o.key = k;
    }
    return o;
  }
  function newCode() {
    let s = ''; const a = new Uint8Array(6);
    (window.crypto || { getRandomValues: x => x.forEach((_, i) => { x[i] = Math.random() * 256; }) }).getRandomValues(a);
    for (let i = 0; i < 6; i++) s += ALPHA[a[i] % ALPHA.length];
    return s;
  }
  const cleanCode = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
  /* DataChannel 收到的二進位可能是 ArrayBuffer / TypedArray / Blob，統一轉 ArrayBuffer */
  async function toBuf(d) {
    if (d instanceof ArrayBuffer) return d;
    if (d && d.buffer instanceof ArrayBuffer) return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
    if (d && typeof d.arrayBuffer === 'function') return d.arrayBuffer();
    return null;
  }
  window.RCNet = { loadPeer, param, peerOptions, newCode, cleanCode, toBuf, PREFIX };
})();
