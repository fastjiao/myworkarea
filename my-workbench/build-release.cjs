#!/usr/bin/env node
/**
 * 构建自用版 + 网络版两个安装包，输出到 ../jiao-release/
 *
 *   网络版：不含 data/（纯净，首启用默认值），体积最小
 *   自用版：含 data/（排除 user-data 运行时缓存），带 tools/uia 本地签到工具 + 当前配置
 *
 * 两版均：排除 data/user-data、afterpack 裁剪多余 locales、data 归位到 exe 同级（绿色便携）
 *
 * 用法： node build-release.cjs
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VER = PKG.version;
const RELEASE_ROOT = path.resolve(ROOT, '..', 'jiao-release');

function rmRf(p) {
  if (!fs.existsSync(p)) return;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const s = path.join(p, e.name);
    if (e.isDirectory()) rmRf(s); else fs.unlinkSync(s);
  }
  fs.rmdirSync(p);
}

const baseConfig = {
  appId: PKG.build.appId,
  productName: PKG.build.productName,
  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'dir', arch: ['x64'] }
    ]
  },
  nsis: PKG.build.nsis,
  files: PKG.build.files,
  asar: true,
  afterPack: path.join(ROOT, 'afterpack-trim.cjs')
};

async function buildVariant(variant, extraResources) {
  const outDir = path.join(RELEASE_ROOT, `教公台-V${VER}-${variant}`);
  console.log(`\n========== 构建 ${variant} -> ${outDir} ==========`);
  if (fs.existsSync(outDir)) {
    console.log(`清理旧产物: ${outDir}`);
    rmRf(outDir);
  }
  fs.mkdirSync(outDir, { recursive: true });

  const config = {
    ...baseConfig,
    directories: { output: outDir },
    extraResources
  };

  const { build } = require('electron-builder');
  await build({ config });
  console.log(`✓ ${variant} 构建完成`);
}

(async () => {
  process.chdir(ROOT);
  process.env.ELECTRON_RUN_AS_NODE = '';
  // 环境代理自签 CA 导致下载 electron/nsis 资源时 TLS 验证失败，构建期临时绕过
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  // 网络版：不含 data（纯净版）
  await buildVariant('网络版', []);

  // 自用版：含 data（排除 user-data 运行时缓存）
  await buildVariant('自用版', [
    { from: 'data/', to: 'data/', filter: ['**/*', '!user-data/**'] }
  ]);

  console.log('\n========== 全部完成 ==========');
  for (const v of ['网络版', '自用版']) {
    const dir = path.join(RELEASE_ROOT, `教公台-V${VER}-${v}`);
    for (const f of fs.readdirSync(dir)) {
      if (f.endsWith('.exe') && !f.endsWith('elevate.exe')) {
        const stat = fs.statSync(path.join(dir, f));
        console.log(`${v}/${f}: ${(stat.size / 1048576).toFixed(2)} MB`);
      }
    }
  }
})().catch(e => {
  console.error('构建失败:', e);
  process.exit(1);
});
