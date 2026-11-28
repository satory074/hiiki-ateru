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
 * league2 は「2つ目の球団は、いちばんの球団と同じリーグか」（2球団の組を半分に絞る暮らしの質問）。
 * eralife は「見始めたころはどうだったか」を聞く暮らしの質問（見始めた年代を見分ける）。
 * feel は「この選手が試合で活躍したら？」（現役の選手ごとに build が作る。詳しい人は他球団の選手も知っているので、知識ではなく気持ちで見分ける。2026-11-28）
 */
export type Kind = "player" | "culture" | "quiz" | "life" | "league2" | "eralife" | "feel" | "foil" | "region";

/**
 * 野球を見始めた年代の4区分（2026-11-27 grilling）。並び順がモデル内の年代番号。
 * 答え合わせで送る値もこの id（ほかに「覚えていない」= unknown）
 */
export const ERA_IDS = ["1990", "2000", "2010", "2020"] as const;
export type EraId = (typeof ERA_IDS)[number];
export const ERA_LABELS: Record<EraId, string> = { "1990": "1990年代以前", "2000": "2000年代", "2010": "2010年代", "2020": "2020年代" };
/** 年代（1990 など、西暦の10年単位）→ 4区分の番号。1990年代より前も「1990年代以前」に入れる */
export const eraIndexOfDecade = (decade: number): number => (decade <= 1990 ? 0 : decade >= 2020 ? 3 : (decade - 1990) / 10);
/**
 * 知名度。A＝野球を見ない人でも聞いたことがある（名物だけ）／B＝野球好きなら名前は知っている／C＝その球団のファンでないとまず知らない／
 * D＝その球団の詳しいファンしか知らない（ライトなファンも知らない。名物だけ。2026-11-28）
 */
export type Tier = "A" | "B" | "C" | "D";
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
  /**
   * 選手が活躍した時期を、見始めた年代の区分で表したもの [はじめ, おわり]（手がかりの「1990〜2000年代」から build で作る）。
   * 「おわり」より後の区分に見始めた人には、見る前の選手として扱う（model.ts の answerProbs）
   */
  span?: [number, number];
  /** eralife の答え方の確率。見始めた年代（ERA_IDS）ごとと、野球を見ない人（none） */
  eralife?: Record<EraId | "none", number[]>;
  /** 同じ選手を別の聞き方で聞く質問の id（選手 ↔ 気持ち）。1 回のゲームではどちらか一方だけ出す */
  twin?: string;
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
   * 見始めた年代（2026-11-27）。prior は4区分の事前確率。
   * retain は「見始める前に活躍を終えた選手」を、まだ知っている度合い（区分が1つ離れるごとに掛ける）。fan＝贔屓球団の選手、other＝それ以外。
   * stopConfidence は年代の確信度がこれに届くまで質問を続ける基準（見ないと言い切る人は問わない）
   */
  era: { prior: number[]; retain: { fan: number; other: number }; stopConfidence: number };
  /**
   * 気持ちの質問（2026-11-28）。known[関係] は、その選手を知っている人の [うれしい, ちょっとくやしい, どちらでもない] の確率。
   * 知らない確率は同じ選手の知識の質問から取る。maxPerGame は 1 回のゲームで出す上限
   */
  feel: { maxPerGame: number; known: Record<Relation, number[]> };
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
