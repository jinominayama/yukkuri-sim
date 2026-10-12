import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 開発用：ページから POST された画像を screenshots/ に保存する（npm run dev の間だけ有効）。
 * 画面が非表示でも、描画した直後のキャンバスをそのまま保存できる。
 *   fetch('/__debug/screenshot?name=xxx', { method: 'POST', body: blob })
 */
function debugScreenshot(): Plugin {
  return {
    name: 'debug-screenshot',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__debug/screenshot', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const url = new URL(req.url ?? '', 'http://localhost');
        const name = (url.searchParams.get('name') ?? 'shot').replace(/[^\w-]/g, '_');
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const dir = path.resolve(process.cwd(), 'screenshots');
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `${name}.png`), Buffer.concat(chunks));
          res.end('ok');
        });
      });
    },
  };
}

export default defineConfig({
  // 配布物は HTML を直接開くので、参照は相対パスにする
  base: './',
  plugins: [debugScreenshot()],
  build: {
    // 1つの HTML に埋め込むので、JS を1つにまとめる
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 2000,
  },
});
