// =====================================================================
// netease-api-host.js —— 网易云 API 服务子进程
// 职责：由主进程 fork 启动；require NeteaseCloudMusicApi 包并起 HTTP 服务（默认 3000）。
//       通过 process.send 向主进程回报启动结果（ok / error）。
// 说明：本脚本运行在主进程侧（被 fork），不参与界面渲染。
//       包 v4.x 导出 server.serveNcmApi(options) → Promise<app>，内部 app.listen(port)。
// =====================================================================

const PORT = 3000;

/** 向主进程回报结果（容错：若 IPC 通道已关闭则忽略） */
function report(ok, extra) {
  try {
    process.send(Object.assign({ ok: ok }, extra || {}));
  } catch (e) {
    // 通道已关闭，忽略
  }
}

try {
  const pkg = require('NeteaseCloudMusicApi');
  // 兼容取 serveNcmApi：v4.x 在 pkg.server.serveNcmApi，也可能直接挂在顶层
  const serveNcmApi = (pkg.server && pkg.server.serveNcmApi) || pkg.serveNcmApi;
  if (typeof serveNcmApi !== 'function') {
    report(false, { error: '无法识别 NeteaseCloudMusicApi 导出（未找到 serveNcmApi）' });
  } else {
    Promise.resolve(serveNcmApi({ port: PORT }))
      .then(() => report(true, { port: PORT }))
      .catch((e) => report(false, { error: 'serveNcmApi 失败：' + e.message }));
  }
} catch (e) {
  // 包未安装：回报失败，主进程据此提示用户安装
  report(false, { error: '未安装 NeteaseCloudMusicApi：' + e.message });
}
