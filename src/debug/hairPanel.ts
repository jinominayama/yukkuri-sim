import type { Outfit } from '../character/Outfit';
import { injectStyle, makeButton, makeRow } from './facePanel';

/**
 * 髪型のパーツ選択画面（開発中のみ）。表情のパーツ選択画面と同じ見た目で、その下に出す。
 * パーツと選択肢は今のキャラクターの hairParts からそのまま作る（キャラクターを変えたら rebuild）。
 * 選べる髪型のないキャラクターでは窓ごと隠す。
 */
export function createHairPanel(parent: HTMLElement, outfit: Outfit): { rebuild(): void } {
  injectStyle();
  const win = document.createElement('div');
  win.className = 'face-panel';
  // 行が少ないので縮めない（縦に足りないときは上の表情の窓がスクロールする）
  win.style.flex = 'none';

  const head = document.createElement('div');
  head.className = 'fp-head';
  const title = document.createElement('span');
  title.textContent = '髪型（パーツ選択）';
  const toggle = document.createElement('span');
  toggle.className = 'fp-toggle';
  head.append(title, toggle);
  const body = document.createElement('div');
  body.className = 'fp-body';
  win.append(head, body);
  parent.appendChild(win);

  const setOpen = (open: boolean) => {
    body.style.display = open ? '' : 'none';
    toggle.textContent = open ? '▾' : '▸';
  };
  let open = true;
  setOpen(open);
  head.addEventListener('click', () => setOpen((open = !open)));

  const rebuild = () => {
    body.innerHTML = '';
    const parts = outfit.character.hairParts ?? [];
    win.style.display = parts.length ? '' : 'none';
    const refreshers: (() => void)[] = [];
    const refresh = () => refreshers.forEach((r) => r());
    for (const def of parts) {
      const row = makeRow(body, def.label);
      for (const opt of def.options) {
        const b = makeButton(row.buttons, opt.name);
        b.addEventListener('click', () => {
          outfit.setHairPart(def.part, opt.id);
          refresh();
        });
        refreshers.push(() => b.classList.toggle('on', outfit.hairPart(def.part) === opt.id));
      }
    }
    refresh();
  };
  rebuild();
  return { rebuild };
}
