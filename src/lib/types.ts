// 当てる仕組みで使う型。src/lib は DOM にも Supabase にも触らない（テストから直接呼べるように）。

export type League = "central" | "pacific";

export interface Team {
  id: string;
  league: League;
  name: string;
  full: string;
  color: string;
  colorDark: string;
  region: string;
}

/**
 * 質問の種類。region は行き詰まったときに1回だけ出す「子どものころの地方」。
 * league2 は「2つ目の球団は、いちばんの球団と同じリーグか」（2球団の組を半分に絞る暮らしの質問）
 */
export type Kind = "player" | "culture" | "quiz" | "life" | "league2" | "foil" | "region";
/** 知名度。A＝野球を見ない人でも聞いたことがある（名物だけ）／B＝野球好きなら名前は知っている／C＝その球団のファンでないとまず知らない */
export type Tier = "A" | "B" | "C";
/** 暮らしの質問で答え方を分ける、仮説の大まかな形 */
export type LifeClass = "fan1" | "fan2" | "neutral" | "none";

/** 配信する質問1つ（data/items/*.yaml を build-bank.ts が変換したもの） */
export interface Item {
  id: string;
  kind: Kind;
  /** ジャンル（player / mascot / food / cheer / stadium / event / quiz / life / region）。「知らない」が続いたら出しにくくする単位 */
  genre: string;
  /** 選手名・名物の名前・質問文 */
  text: string;
  /** 選手なら「投手・2010年代」など。球団名は入れない */
  hint?: string;
  /** 関係する球団の番号（teams の並び順）。life / foil / region は空 */
  teams: number[];
  tier: Tier;
  /** 画面に出す答えの選択肢 */
  options: string[];
  /** quiz の正解の番号（options の中の位置） */
  correct?: number;
  /** life の答え方の確率。各形ごとに options と同じ長さ。G ごとに分けるなら3つの配列 */
  life?: Record<LifeClass, number[] | number[][]>;
  /** league2 の答え方の確率。2球団の組は同じリーグ（sameLeague）か違うリーグ（crossLeague）かで分ける */
  league2?: Record<"sameLeague" | "crossLeague" | "fan1" | "neutral" | "none", number[]>;
  /** foil が何に見えるか（player / culture）。種明かしまで画面上は本物と同じに見せる */
  look?: "player" | "culture";
}

export interface Params {
  tau: number;
  prior: Record<LifeClass, number>;
  priorG: number[];
  priorO: number[];
  overclaimLambda: number;
  /** know[関係][知名度][G] = [よく知ってる, 名前は知ってる, 知らない] */
  know: Record<Relation, Record<Tier, number[][]>>;
  /** quiz[関係][G] = [正解, 不正解, わからない] */
  quiz: Record<Relation, number[][]>;
  foil: number[];
  regions: {
    names: string[];
    population: number[];
    homeShare: number;
    elsewhere: { label: string; p: number };
  };
  stop: { min: number; max: number; confidence: number };
  /**
   * 架空の質問を入れる番手の窓（[はじめ, おわり]、両端を含む）。遊ぶたびに窓の中の1問をくじで選ぶ。
   * 番手を固定すると「4問目は架空」と広まって意味がなくなり、短く終わると1問しか入らなかったので窓にした（2026-11-25）。
   */
  foilWindows: [number, number][];
  /** 1問目に必ず出す質問の id（見ない人・贔屓なしの人を早く見分けるため、中継を見る頻度を最初に聞く） */
  firstItem?: string;
  regionFallback: { minQuestions: number; below: number; stallWindow: number; stallGain: number };
  genrePenalty: { streak: number; factor: number };
  pickWithin: number;
  /**
   * 答え合わせから直した、質問ごとの答え方（scripts/reflect.ts --write が書く）。
   * 選手・名物・架空は関係ごとの [よく知ってる, 名前は知ってる, 知らない]、クイズは [正解, 不正解, わからない]、
   * 暮らしは形（fan1 / fan2 / neutral / none）ごとの選択肢の確率。詳しさ G で分けない。
   */
  itemOverrides?: Record<string, Partial<Record<string, number[]>>>;
}

export type Relation = "fan" | "same" | "other" | "neutral" | "none";

export interface Bank {
  /** モデルの版（質問と数字から作る8桁）。答え合わせの集計はこの版ごとに分ける */
  version: string;
  teams: Team[];
  params: Params;
  items: Item[];
}

/** 仮説: 本命1球団 / 2球団 / 贔屓なし / 野球を見ない */
export interface Hyp {
  kind: LifeClass;
  teams: number[];
}

export interface Answer {
  itemId: string;
  answer: number;
}

/** 結果の15種類。0〜11 が本命の球団、12 が複数、13 が贔屓なし、14 が野球を見ない */
export const OUTCOME_MULTI = 12;
export const OUTCOME_NEUTRAL = 13;
export const OUTCOME_NONE = 14;
export const N_OUTCOMES = 15;
