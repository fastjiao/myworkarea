// =====================================================================
// block-external-protocol-preload.js —— 外部协议拦截 preload
// 职责：在页面任何脚本之前注入拦截 bytedance:// 等外部协议的代码
// 说明：
//   - 抖音网页在滑动/登录时会触发 bytedance:// 唤起 PC 客户端，未装客户端时
//     Chromium 弹出"没有应用可打开此链接"的内置提示，打断体验
//   - 主进程的 will-navigate 等事件对外部协议可能不触发（外部协议不走导航流程）
//   - did-finish-load 注入晚于页面脚本，且动态 iframe 注入不到
//   - preload 在页面脚本之前执行，能最早拦截用户交互触发的外部协议
// =====================================================================

const { webFrame } = require('electron');

// 注入到页面主世界的拦截代码
const injectCode = `(function(){
  var blocked = ['bytedance:','snssdk:','aweme:','tianyi:','taobao:','alipays:','wechat:','mqqapi:'];
  function isBlocked(u){
    try { return blocked.indexOf(new URL(u).protocol) !== -1; } catch(e){ return false; }
  }
  // 对单个 window 注入拦截（主框架 + 同源 iframe 复用）
  function install(win){
    try {
      // 拦截 window.open
      var o = win.open;
      win.open = function(u){ if(isBlocked(u)) return null; return o.apply(this, arguments); };
      var doc = win.document;
      // 拦截 <a> 点击（capture 阶段最早捕获，含程序化 click()）
      doc.addEventListener('click', function(e){
        var n = e.target;
        while(n && n.tagName !== 'A') n = n.parentElement;
        if(n && n.href && isBlocked(n.href)){ e.preventDefault(); e.stopPropagation(); }
      }, true);
      // 拦截 location.href / assign / replace
      var loc = win.location;
      try {
        var p = Object.getPrototypeOf(loc);
        var d = Object.getOwnPropertyDescriptor(p, 'href');
        if(d && d.set){
          Object.defineProperty(loc, 'href', { get: d.get, set: function(v){ if(!isBlocked(v)) d.set.call(this, v); } });
        }
        if(loc.assign){ var oa = loc.assign.bind(loc); loc.assign = function(u){ if(!isBlocked(u)) oa(u); }; }
        if(loc.replace){ var or = loc.replace.bind(loc); loc.replace = function(u){ if(!isBlocked(u)) or(u); }; }
      } catch(e){}
      // MutationObserver 监听动态创建的 iframe，同源的也注入（跨源访问 contentWindow 会抛错，靠主进程兜底）
      var obs = new MutationObserver(function(muts){
        muts.forEach(function(m){
          m.addedNodes.forEach(function(node){
            if(node.tagName === 'IFRAME'){
              try { if(node.contentWindow) install(node.contentWindow); } catch(e){}
            }
          });
        });
      });
      obs.observe(doc, { childList: true, subtree: true });
    } catch(e){}
  }
  install(window);
})();`;

// 在页面主世界执行拦截代码（contextIsolation:true 时 webFrame.executeJavaScript 注入主世界）
webFrame.executeJavaScript(injectCode).catch(() => {});
