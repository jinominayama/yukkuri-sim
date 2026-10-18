import type { Face } from '../face/Face';
import { EXPRESSIONS } from '../face/expressions';
import { PARTS, selectedIds, toggleId, type FacePart } from '../face/parts';

/**
 * 表情のパーツ選択画面（開発中のみ）。画面左上、体型の説明の下に出す小さな窓。
 *   ・まとめて設定：表情セットのボタン。押すと全パーツをその表情に合わせる
 *   ・パーツごとの行：選択肢のボタンと、左右反転の切り替え
 * パーツや選択肢は face/parts.ts のデータからそのまま作るので、データを足せばボタンも増える。
 */
export function createFacePanel(parent: HTMLElement, face: Face): void {
  injectStyle();
  const win = document.createElement('div');
  win.className = 'face-panel';

  // 見出し（クリックで開閉）
  const head = document.createElement('div');
  head.className = 'fp-head';
  const title = document.createElement('span');
  title.textContent = '表情（パーツ選択）';
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
  let open = false; // 最初は畳んでおく（見出しを押すと開く）
  setOpen(open);
  head.addEventListener('click', () => setOpen((open = !open)));

  const refreshers: (() => void)[] = [];
  const refresh = () => refreshers.forEach((r) => r());

  // まとめて設定（表情セット）
  {
    const row = makeRow(body, 'まとめて', '表情セット：押すと全パーツをその表情に合わせる（左右反転は解除）');
    for (const set of EXPRESSIONS) {
      const b = makeButton(row.buttons, set.name);
      b.addEventListener('click', () => {
        face.setExpression(set.id);
        refresh();
      });
      refreshers.push(() => {
        const s = face.settings;
        const same = PARTS.every((p) => s.parts[p.part] === set.parts[p.part]) &&
          PARTS.every((p) => !s.flip[p.part]);
        b.classList.toggle('on', same);
      });
    }
  }
  const sep = document.createElement('div');
  sep.className = 'fp-sep';
  body.appendChild(sep);

  // パーツごと：行を作って左右反転のボタンを付ける
  const rows = new Map<FacePart, ReturnType<typeof makeRow>>();
  for (const def of PARTS) {
    const row = makeRow(body, def.label);
    rows.set(def.part, row);
    if (!def.noFlip) addFlip(row, def);
  }
  function addFlip(row: { label: HTMLElement }, def: (typeof PARTS)[number]): void {
    // 左右反転
    const flip = document.createElement('button');
    flip.type = 'button';
    flip.className = 'fp-flip';
    flip.textContent = '⇆';
    flip.title = `${def.label}を左右反転`;
    flip.addEventListener('click', () => {
      face.setFlip(def.part, !face.settings.flip[def.part]);
      refresh();
    });
    row.label.appendChild(flip);
    refreshers.push(() => flip.classList.toggle('on', face.settings.flip[def.part as FacePart]));
  }
  for (const def of PARTS) {
    const row = rows.get(def.part)!;
    if (def.multi) {
      // 選択肢ごとにオン・オフ。先頭に「全部」「なし」
      const all = makeButton(row.buttons, '全部');
      all.classList.add('fp-sub');
      all.addEventListener('click', () => {
        face.setPart(def.part, def.options.map((o) => o.id).join(','));
        refresh();
      });
      refreshers.push(() => all.classList.toggle('on', selectedIds(face.settings.parts[def.part]).length === def.options.length));
      const none = makeButton(row.buttons, 'なし');
      none.classList.add('fp-sub');
      none.addEventListener('click', () => {
        face.setPart(def.part, '');
        refresh();
      });
      refreshers.push(() => none.classList.toggle('on', selectedIds(face.settings.parts[def.part]).length === 0));
      for (const opt of def.options) {
        const b = makeButton(row.buttons, opt.name);
        b.classList.add('fp-toggle-btn');
        b.addEventListener('click', () => {
          face.setPart(def.part, toggleId(def, face.settings.parts[def.part], opt.id));
          refresh();
        });
        refreshers.push(() => b.classList.toggle('on', selectedIds(face.settings.parts[def.part]).includes(opt.id)));
      }
      continue;
    }
    for (const opt of def.options) {
      const b = makeButton(row.buttons, opt.name);
      b.addEventListener('click', () => {
        face.setPart(def.part, opt.id);
        refresh();
      });
      refreshers.push(() => b.classList.toggle('on', face.settings.parts[def.part] === opt.id));
    }
  }
  refresh();
}

export function makeRow(parent: HTMLElement, label: string, tip?: string): { label: HTMLElement; buttons: HTMLElement } {
  const row = document.createElement('div');
  row.className = 'fp-row';
  const l = document.createElement('div');
  l.className = 'fp-label';
  const name = document.createElement('span');
  name.textContent = label;
  if (tip) l.title = tip;
  l.appendChild(name);
  const buttons = document.createElement('div');
  buttons.className = 'fp-buttons';
  row.append(l, buttons);
  parent.appendChild(row);
  return { label: l, buttons };
}

export function makeButton(parent: HTMLElement, text: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'fp-btn';
  b.textContent = text;
  parent.appendChild(b);
  return b;
}

export function injectStyle(): void {
  if (document.getElementById('face-panel-style')) return;
  const style = document.createElement('style');
  style.id = 'face-panel-style';
  style.textContent = `
    .face-panel {
      pointer-events: auto; width: 360px; max-width: calc(100vw - 280px);
      font: 12px/1.4 system-ui, sans-serif; color: #5a4a3a;
      background: rgba(255, 252, 247, 0.94); border: 1px solid #e3d8ca; border-radius: 6px;
      box-shadow: 0 2px 8px rgba(90, 70, 50, 0.12); overflow: hidden;
      display: flex; flex-direction: column; min-height: 0;
    }
    .face-panel .fp-head {
      display: flex; justify-content: space-between; align-items: center;
      padding: 5px 10px; background: #efe5d8; font-weight: bold; cursor: pointer; user-select: none;
    }
    .face-panel .fp-body { padding: 6px 8px 8px; overflow-y: auto; min-height: 0; }
    .face-panel .fp-row { display: flex; gap: 6px; padding: 3px 0; }
    .face-panel .fp-label {
      flex: none; width: 82px; display: flex; align-items: flex-start; justify-content: space-between;
      padding-top: 3px; font-weight: bold; color: #7a6450; white-space: nowrap;
    }
    .face-panel .fp-buttons { display: flex; flex-wrap: wrap; align-items: flex-start; align-content: flex-start; gap: 3px; }
    .face-panel .fp-sep { border-top: 1px dashed #e0d3c2; margin: 4px 0; }
    .face-panel button {
      font: inherit; font-size: 11.5px; color: #5a4a3a; cursor: pointer;
      background: #fff; border: 1px solid #d8c9b6; border-radius: 10px; padding: 2px 8px;
    }
    .face-panel button:hover { border-color: #b08a64; }
    .face-panel button.on { background: #8a5a36; border-color: #8a5a36; color: #fff; }
    .face-panel button.fp-sub { border-style: dashed; }
    .face-panel button.fp-toggle-btn { border-radius: 4px; }
    .face-panel .fp-flip { padding: 0 4px; border-radius: 4px; font-size: 12px; line-height: 16px; }
  `;
  document.head.appendChild(style);
}
