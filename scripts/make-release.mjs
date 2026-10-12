// テスト版の配布物を作る：npm run release
//
// vite build の出力（dist/）の JS・CSS を index.html に埋め込み、1つの HTML ファイルにする。
// ブラウザで HTML をダブルクリックで開く（file://）と、別ファイルの JS は読み込みを止められるため。
// 出来上がったものは release/ に置き、README と一緒に zip にまとめる。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const dist = path.join(root, 'dist');
const name = `yukkuri-sim-test-v${pkg.version}`;
const outDir = path.join(root, 'release', name);

let html = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
const read = (src) => fs.readFileSync(path.join(dist, src.replace(/^\.?\//, '')), 'utf8');

// <script type="module" ... src="..."></script> → 中身を埋め込む（中の </script を壊さないように）
html = html.replace(/<script([^>]*?)\s+src="([^"]+)"([^>]*)><\/script>/g, (_, a, src, b) => {
  const attrs = `${a}${b}`.replace(/\s*crossorigin/g, '');
  return `<script${attrs}>${read(src).replace(/<\/script/gi, '<\\/script')}</script>`;
});
// <link rel="stylesheet" href="..."> → <style>
html = html.replace(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g, (_, href) => `<style>${read(href)}</style>`);
// 埋め込めなかったもの（別ファイルを参照したまま）が残っていないか
const left = html.match(/<(script|link)[^>]+(src|href)="(?!data:|https?:)[^"]+"/g);
if (left) {
  console.error('埋め込めなかった参照があります:', left);
  process.exit(1);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'ゆっくり観察.html'), html);
fs.copyFileSync(path.join(root, 'release-readme.txt'), path.join(outDir, 'はじめにお読みください.txt'));

// zip（Windows は PowerShell、それ以外は zip コマンド）
const zip = path.join(root, 'release', `${name}.zip`);
fs.rmSync(zip, { force: true });
if (process.platform === 'win32') {
  execFileSync('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Path '${outDir}' -DestinationPath '${zip}'`], { stdio: 'inherit' });
} else {
  execFileSync('zip', ['-r', zip, name], { cwd: path.join(root, 'release'), stdio: 'inherit' });
}
console.log(`作成しました: ${path.relative(root, outDir)}  /  ${path.relative(root, zip)}`);
