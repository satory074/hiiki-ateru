// data/ の YAML・JSON を読み、配信用の Bank に変換する（build-bank / check-items / simulate などで共有）。
//
// 質問の YAML（data/items/*.yaml）の書き方:
//   items:
//     - id: carp-p-kikuchi     # 英小文字・数字・ハイフン。全体で一意
//       kind: player           # player / culture / quiz / life / league2 / eralife / foil
//       genre: player          # player / mascot / food / cheer / stadium / event / quiz / life
//       text: 菊池涼介          # 選手名・名物の名前・質問文。球団名は入れない
//       hint: 内野手・2010年代   # 選手は必須（守備と主な年代）。名物は「球場グルメ」などの分類
//                              # 選手の年代は見始めた年代の推定に使う（「1990〜2000年代」のおわりより後に見始めた人には、見る前の選手）
//       teams: [carp]          # player / culture / quiz は 1〜3 球団。life / foil は書かない
//       tier: C                # A（野球を見ない人でも聞いたことがある。culture だけ）/ B（野球好きなら名前は知っている）/ C（その球団のファンでないとまず知らない）
//                              # / D（その球団の詳しいファンしか知らない。culture だけ）
//       （現役 era: current の選手には、build が気持ちの質問「この選手が試合で活躍したら？」（id は <選手の id>-feel）を自動で足す）
//       era: current           # player だけ: current（2026年に在籍）/ ob
//       source: https://...    # 出典。foil 以外は必須
//       check: auto            # auto（intai-fa と照合して一致）/ owner（オーナー確認待ち）/ ok（オーナー確認済み）
//       choices: [..4つ]       # quiz だけ
//       answer: 0              # quiz だけ。正解の位置
//       options: [..]          # life / league2 / eralife だけ
//       probs: { fan1: [..], fan2: [..], neutral: [..], none: [..] }  # life だけ。options と同じ長さ（G 別なら3行）
//       probs: { sameLeague: [..], crossLeague: [..], fan1: [..], neutral: [..], none: [..] }  # league2 だけ
//       probs: { "1990": [..], "2000": [..], "2010": [..], "2020": [..], none: [..] }  # eralife だけ（見始めた年代ごと。none は野球を見ない人）
//       look: player           # foil だけ: player / culture
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import YAML from "yaml";
import { ERA_IDS, eraIndexOfDecade, type Bank, type Item, type Kind, type LifeClass, type Params, type Team, type Tier } from "../../src/lib/types";

export const ROOT = path.resolve(import.meta.dirname, "../..");
const DATA = path.join(ROOT, "data");

// 「よく知ってる」と「名前は知ってる」の境目が人によって違わないよう、短い定義を添える（2026-11-25 見直し）
export const KNOW_OPTIONS = ["よく知ってる（どんな選手か浮かぶ）", "名前は知ってる（名前だけ）", "知らない"];
export const CULTURE_OPTIONS = ["よく知ってる（どんなものか言える）", "聞いたことはある（名前だけ）", "知らない"];
export const DONT_KNOW_QUIZ = "わからない";
// 気持ちの質問（2026-11-28）。最後は「知らない」（isDontKnow が最後の選択肢を知らないとみなす）
export const FEEL_OPTIONS = ["うれしい", "ちょっとくやしい", "どちらでもない", "この選手を知らない"];
export const REGION_TEXT = "子どものころ、いちばん長く住んでいた地方は？";

export interface RawItem {
  id: string;
  kind: Kind;
  genre: string;
  text: string;
  hint?: string;
  teams?: string[];
  tier?: Tier;
  era?: "current" | "ob";
  source?: string;
  check?: "auto" | "owner" | "ok";
  choices?: string[];
  answer?: number;
  options?: string[];
  probs?: Record<string, number[] | number[][]>;
  look?: "player" | "culture";
  note?: string;
  /** どのファイルから来たか（エラー表示用） */
  file: string;
}

export interface Source {
  teams: Team[];
  params: Params;
  items: RawItem[];
}

export function loadSource(): Source {
  const teams = (YAML.parse(fs.readFileSync(path.join(DATA, "teams.yaml"), "utf8")) as { teams: Team[] }).teams;
  const params = JSON.parse(fs.readFileSync(path.join(DATA, "likelihood.json"), "utf8")) as Params;
  const items: RawItem[] = [];
  const dir = path.join(DATA, "items");
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".yaml")).sort()) {
    const doc = YAML.parse(fs.readFileSync(path.join(dir, f), "utf8")) as { items?: Omit<RawItem, "file">[] } | null;
    for (const it of doc?.items ?? []) items.push({ ...it, file: f });
  }
  return { teams, params, items };
}

const KINDS: Kind[] = ["player", "culture", "quiz", "life", "league2", "eralife", "foil"];
const ERALIFE_KEYS = [...ERA_IDS, "none"] as const;

/**
 * 選手の手がかり「投手・1990〜2000年代」から、活躍した年代 [はじめ, おわり]（西暦の10年単位）を読む。
 * 「2010〜20年代」のような2桁の書き方も読む。読めなければ null
 */
export function decadesOfHint(hint: string): [number, number] | null {
  const m = hint.match(/(\d{4})(?:〜(\d{2}|\d{4}))?年代$/);
  if (!m) return null;
  const a = Number(m[1]);
  let b = m[2] === undefined ? a : m[2].length === 4 ? Number(m[2]) : Math.floor(a / 100) * 100 + Number(m[2]);
  if (b < a) b += 100;
  return [a, b];
}
const LEAGUE2_KEYS = ["sameLeague", "crossLeague", "fan1", "neutral", "none"] as const;
const LIFE_CLASSES: LifeClass[] = ["fan1", "fan2", "neutral", "none"];

/** Bank に変換する。形が壊れていたら例外（中身の方針の検査は check-items.ts） */
export function compileBank(src: Source): Bank {
  const teamIndex = new Map(src.teams.map((t, i) => [t.id, i]));
  const seen = new Set<string>();
  const fail = (it: RawItem, msg: string): never => {
    throw new Error(`${it.file} ${it.id ?? "(id なし)"}: ${msg}`);
  };
  const items: Item[] = src.items.flatMap((it) => {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(it.id ?? "")) fail(it, "id は英小文字・数字・ハイフン");
    if (seen.has(it.id)) fail(it, "id が重複");
    seen.add(it.id);
    if (!KINDS.includes(it.kind)) fail(it, `kind が不正: ${it.kind}`);
    if (!it.text) fail(it, "text が空");
    const needsTeams = it.kind === "player" || it.kind === "culture" || it.kind === "quiz";
    const teams = (it.teams ?? []).map((id) => teamIndex.get(id) ?? fail(it, `球団 id が不正: ${id}`));
    if (needsTeams && (teams.length < 1 || teams.length > 3)) fail(it, "teams は 1〜3 球団");
    if (!needsTeams && teams.length > 0) fail(it, `${it.kind} に teams は書かない`);
    const tier: Tier = it.tier ?? "C";
    if (tier !== "A" && tier !== "B" && tier !== "C" && tier !== "D") fail(it, `tier が不正: ${tier}`);
    // A は「野球を見ない人でも聞いたことがある」名物だけ。選手は誰でも知っているスターを使わない決まりなので A にしない
    if (tier === "A" && it.kind !== "culture") fail(it, "tier A は culture（名物）だけ");
    // D は「その球団の詳しいファンしか知らない」名物だけ（応援の決まりごと・2軍の球場・球団の行事）
    if (tier === "D" && it.kind !== "culture") fail(it, "tier D は culture（名物）だけ");

    let options: string[];
    let correct: number | undefined;
    let life: Item["life"];
    if (it.kind === "player") options = KNOW_OPTIONS;
    else if (it.kind === "culture") options = CULTURE_OPTIONS;
    else if (it.kind === "foil") options = it.look === "culture" ? CULTURE_OPTIONS : KNOW_OPTIONS;
    else if (it.kind === "quiz") {
      if (!Array.isArray(it.choices) || it.choices.length !== 4) fail(it, "quiz の choices は4つ");
      if (!(Number.isInteger(it.answer) && it.answer! >= 0 && it.answer! < 4)) fail(it, "quiz の answer は 0〜3");
      options = [...it.choices!, DONT_KNOW_QUIZ];
      correct = it.answer;
    } else if (it.kind === "eralife") {
      if (!Array.isArray(it.options) || it.options.length < 2) fail(it, "eralife の options は2つ以上");
      options = it.options!;
      for (const k of ERALIFE_KEYS) {
        const row = it.probs?.[k];
        if (!Array.isArray(row) || row.length !== options.length || (row as number[]).some((x) => !(x >= 0))) fail(it, `probs.${k} が不正`);
      }
    } else if (it.kind === "league2") {
      if (!Array.isArray(it.options) || it.options.length < 2) fail(it, "league2 の options は2つ以上");
      options = it.options!;
      for (const k of LEAGUE2_KEYS) {
        const row = it.probs?.[k];
        if (!Array.isArray(row) || row.length !== options.length || (row as number[]).some((x) => !(x >= 0))) fail(it, `probs.${k} が不正`);
      }
    } else {
      if (!Array.isArray(it.options) || it.options.length < 2) fail(it, "life の options は2つ以上");
      options = it.options!;
      if (!it.probs) fail(it, "life には probs が要る");
      for (const c of LIFE_CLASSES) {
        const row = it.probs![c];
        if (!Array.isArray(row)) fail(it, `probs.${c} がない`);
        const rows = Array.isArray(row[0]) ? (row as number[][]) : [row as number[]];
        if (Array.isArray(row[0]) && rows.length !== 3) fail(it, `probs.${c} は G 別なら3行`);
        for (const r of rows)
          if (r.length !== options.length || r.some((x) => !(x >= 0))) fail(it, `probs.${c} の長さか値が不正`);
      }
      life = it.probs as Item["life"];
    }
    const item: Item = { id: it.id, kind: it.kind, genre: it.genre, text: it.text, teams, tier, options };
    if (it.hint) item.hint = it.hint;
    if (correct !== undefined) item.correct = correct;
    if (life) item.life = life;
    if (it.kind === "league2") item.league2 = it.probs as Item["league2"];
    if (it.kind === "eralife") item.eralife = it.probs as Item["eralife"];
    if (it.kind === "player") {
      const d = decadesOfHint(it.hint ?? "");
      if (!d) fail(it, `手がかりから年代を読めない: ${it.hint ?? "なし"}`);
      item.span = [eraIndexOfDecade(d![0]), eraIndexOfDecade(d![1])];
    }
    if (it.kind === "foil") item.look = it.look === "culture" ? "culture" : "player";
    // 現役の選手には気持ちの質問を足す（OB は「活躍したら？」と聞けないので足さない）
    if (it.kind === "player" && it.era === "current") {
      const feel: Item = { ...item, id: `${it.id}-feel`, kind: "feel", genre: "feel", options: FEEL_OPTIONS, twin: it.id };
      item.twin = feel.id;
      return [item, feel];
    }
    return [item];
  });

  const r = src.params.regions;
  items.push({
    id: "region",
    kind: "region",
    genre: "region",
    text: REGION_TEXT,
    teams: [],
    tier: "C",
    options: [...r.names, r.elsewhere.label],
  });

  const version = crypto
    .createHash("sha256")
    .update(JSON.stringify({ teams: src.teams.map((t) => [t.id, t.league, t.region]), params: src.params, items }))
    .digest("hex")
    .slice(0, 8);
  return { version, teams: src.teams, params: src.params, items };
}
