// くじ（質問の同点決勝・架空の質問の選び出し）。テストで再現できるよう種を渡せる。
export type Rng = () => number;

/** mulberry32: 32bit の種から [0,1) の乱数列を作る */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
