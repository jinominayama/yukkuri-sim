/**
 * 設定の保存先。
 * ブラウザ版は localStorage。デスクトップ版（Tauri）ではここをファイル保存に差し替える。
 * 保存できない環境（プライベートブラウズ等）でも動作は止めない。
 */
const PREFIX = 'yukkuri-sim.';

export function loadJSON<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

export function saveJSON(key: string, value: unknown): boolean {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function remove(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // 保存できない環境では何もしない
  }
}
