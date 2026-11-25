// 画面の層（DOM を触るのはここだけ）。当てる仕組みは src/lib、送り先は api.ts。
// 本物の依存は real.ts が差し込み、テスト（scripts/domtest.ts）は偽物を差し込む。
import { Model, fanShare, verdict, type Verdict } from "../lib/model";
import { answer, newSession, nextItem, topConfidence, type Next, type Session } from "../lib/select";
import { decisive, describeItem, headline, hypLabel, outcomeKey, overclaim, rankedHyps, shareText } from "../lib/explain";
import { OUTCOME_MULTI, OUTCOME_NEUTRAL, type Bank, type Item, type Team } from "../lib/types";
import type { Rng } from "../lib/rng";
import type { ResultApi, ResultPayload } from "./api";
import type { ShareCard } from "./canvas-share";

export interface GameDeps {
  bank: Bank;
  api: ResultApi;
  rng: Rng;
  /** 公開 URL の起点（末尾 /）。シェアに載せる結果ページの URL を作る */
  siteUrl: string;
  /** 新しいタブで開く（テストでは差し替える） */
  openUrl?: (url: string) => void;
  /** 画像でシェア（テストでは差し替える）。成功したら true */
  shareImage?: (card: ShareCard, preview: HTMLElement) => Promise<boolean>;
  /**
   * この端末から、その版の答え合わせを送ったかの記録（同じ人の2回目以降を数えないため。年齢当ても最初の1回だけ数える）。
   * 無ければ毎回送る。本物は localStorage（real.ts）
   */
  sentStore?: { has(version: string): boolean; mark(version: string): void };
}

type Attrs = Record<string, string | number | boolean | undefined>;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: (Node | string | null | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "style") el.setAttribute("style", String(v));
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children) if (c !== null && c !== false) el.append(c);
  return el;
}

const pct = (p: number) => `${Math.round(p * 100)}%`;
const teamStyle = (t: Team) => `--team-light:${t.color};--team-dark:${t.colorDark}`;

/** 質問の上に出す「何を聞いているか」 */
function kindLabel(item: Item): string {
  const look = item.kind === "foil" ? item.look : item.kind;
  if (look === "player") return "この選手を知っていますか？";
  if (look === "culture") return item.hint ? `この${item.hint}を知っていますか？` : "これを知っていますか？";
  if (item.kind === "quiz") return "クイズ（わからなければ「わからない」）";
  if (item.kind === "region") return "あなたのこと（これだけは1回だけ聞きます）";
  return "あなたのこと";
}

/** 答え合わせが当たりだったか */
export function judge(v: Verdict, teams: Team[], main: string, others: string[]): "hit" | "near" | "miss" {
  const ids = teams.map((t) => t.id);
  if (v.outcome < teams.length) {
    if (main === ids[v.outcome]) return "hit";
    return others.includes(ids[v.outcome]!) ? "near" : "miss";
  }
  if (v.outcome === OUTCOME_MULTI) {
    const pair = v.teams.map((t) => ids[t]!);
    const liked = [main, ...others];
    if (pair.includes(main) && pair.every((t) => liked.includes(t))) return "hit";
    return pair.some((t) => liked.includes(t)) ? "near" : "miss";
  }
  if (v.outcome === OUTCOME_NEUTRAL) return main === "none" ? "hit" : "miss";
  return main === "nobaseball" ? "hit" : "miss";
}

export function mountGame(root: HTMLElement, deps: GameDeps) {
  const model = new Model(deps.bank);
  const teams = deps.bank.teams;
  const openUrl = deps.openUrl ?? ((url: string) => window.open(url, "_blank", "noopener"));
  let session: Session = newSession(model);
  let steps: { item: Item; answer: number }[] = [];
  let current: Next = null;
  let finalVerdict: Verdict | null = null;

  function start(): void {
    session = newSession(model);
    steps = [];
    finalVerdict = null;
    current = nextItem(model, session, deps.rng);
    showQuestion();
  }

  function showQuestion(): void {
    if (!current) return finish();
    const item = current.item;
    const n = steps.length + 1;
    const conf = topConfidence(model, session.post);
    const on = Math.round(conf * 20);
    const meter = h("span", { class: "meter", "aria-hidden": "true" });
    for (let i = 0; i < 20; i++) meter.append(h("i", { class: i < on ? "on" : undefined }));
    const title = h("h2", { class: "q-text", tabindex: "-1" }, item.text);
    const options = h("div", { class: "options", role: "group", "aria-label": "答え" });
    item.options.forEach((label, a) => options.append(h("button", { class: "opt", type: "button", "data-action": "answer", "data-a": a }, label)));
    const showHint = item.hint && (item.kind === "player" || (item.kind === "foil" && item.look === "player"));
    root.replaceChildren(
      h(
        "section",
        { class: "board", "data-view": "question", "data-item": item.id },
        h("div", { class: "board-row" }, h("span", { class: "qno" }, `Q.${String(n).padStart(2, "0")}`), meter, h("span", { class: "meter-label" }, `確信度 ${pct(conf)}`)),
        h("p", { class: "q-kind" }, kindLabel(item)),
        title,
        showHint ? h("p", { class: "q-hint" }, item.hint!) : null,
        options,
        h(
          "div",
          { class: "board-foot" },
          h("button", { class: "link-btn", type: "button", "data-action": "back", disabled: steps.length === 0 }, "1問もどる"),
          h("span", { class: "small", style: "color:var(--board-soft)" }, `${deps.bank.params.stop.min}〜${deps.bank.params.stop.max}問`),
        ),
      ),
    );
    title.focus({ preventScroll: true });
  }

  function choose(a: number): void {
    if (!current) return;
    answer(model, session, current.item, a);
    steps.push({ item: current.item, answer: a });
    current = nextItem(model, session, deps.rng);
    showQuestion();
  }

  /** 1問もどる: 最後の答えを取り消し、それまでの答えで事後確率を作り直す */
  function back(): void {
    const last = steps.pop();
    if (!last) return;
    // 架空を出す番手は引き継ぐ（引き直すと、同じ窓に2問目の架空が出ることがある）
    session = newSession(model, session.foilAt);
    for (const s of steps) answer(model, session, s.item, s.answer);
    current = { item: last.item, reason: "gain" };
    showQuestion();
  }

  function finish(): void {
    const v = verdict(model, session.post);
    finalVerdict = v;
    const n = steps.length;
    const shares = fanShare(model, session.post);
    const order = teams.map((t, i) => ({ t, i, p: shares[i]! })).sort((a, b) => b.p - a.p);
    const d = decisive(model, session.post, session.answers);
    const oc = overclaim(model, session.answers);
    const runners = rankedHyps(model, session.post).filter((r) => r.hyp !== v.hyp).slice(0, 3);

    const verdictEl = h("p", { class: "verdict", tabindex: "-1" });
    const text = headline(teams, v);
    if (v.teams.length) {
      // 球団名だけに球団カラーの下線を引く
      let rest = text;
      for (const ti of v.teams) {
        const name = teams[ti]!.name;
        const at = rest.indexOf(name);
        verdictEl.append(rest.slice(0, at), h("span", { class: "verdict-team", style: teamStyle(teams[ti]!) }, name));
        rest = rest.slice(at + name.length);
      }
      verdictEl.append(rest);
    } else verdictEl.append(text);

    const bars = h("ul", { class: "bars" });
    for (const { t, p } of order)
      bars.append(
        h("li", { class: "bar", style: teamStyle(t) }, h("span", {}, t.name), h("span", { class: "bar-track" }, h("span", { class: "bar-fill", style: `width:${Math.max(1, p * 100).toFixed(1)}%` })), h("span", { class: "bar-pct" }, pct(p))),
      );

    const foilSteps = steps.filter((s) => s.item.kind === "foil");
    // 架空の質問の種明かし。1問だけでは何も言えないので2問以上のときだけ出す。
    // 詳しい人ほど「知っている気がする」ものなので（Atir ほか 2015）、責める言い方にしない（2026-11-25 見直し）
    const ocText =
      oc.claimed === 0
        ? `実は、実在しない選手や名物を${oc.asked}問まぜていました。どれにも「知らない」と答えています。`
        : `実は、実在しない選手や名物を${oc.asked}問まぜていました。そのうち${oc.claimed}問に「知らない」以外で答えています。` +
          "詳しい人ほど、似た名前を知っている気がするものです。当てるときは、この分を割り引いて考えています。";

    const answersList = h("ol", { class: "answers-list" });
    for (const s of steps) {
      const tag =
        s.item.kind === "foil"
          ? h("span", { class: "tag" }, "架空")
          : s.item.kind === "quiz"
            ? h("span", { class: "tag" }, s.answer === s.item.correct ? "正解" : `正解は${s.item.options[s.item.correct!]}`)
            : null;
      answersList.append(h("li", {}, `${describeItem(teams, s.item)} → 「${s.item.options[s.answer]}」`, tag));
    }

    const key = outcomeKey(teams, v.outcome);
    const resultUrl = `${deps.siteUrl}result/${key}/`;
    const preview = h("div", { class: "share-area" });

    const sections: (HTMLElement | null)[] = [
      h(
        "section",
        { class: "board", "data-view": "result", "data-outcome": key },
        h("div", { class: "board-row" }, h("span", { class: "qno" }, "RESULT"), h("span", {}, `${n}問・確信度 ${pct(v.confidence)}`)),
        verdictEl,
        runners.length ? h("p", { class: "q-hint" }, `次にありそう: ${runners.map((r) => `${hypLabel(model, r.hyp)} ${pct(r.p)}`).join("、")}`) : null,
      ),
      h(
        "section",
        { class: "section" },
        h("h2", {}, "知識の偏り"),
        h("p", { class: "small" }, "答えから計算した、それぞれの球団があなたの贔屓（2球団なら片方）である確率です。"),
        bars,
      ),
      d
        ? h(
            "section",
            { class: "section" },
            h("h2", {}, "決め手"),
            h("p", { class: "callout" }, `${describeItem(teams, d.item)}に「${d.item.options[d.answer]}」と答えたこと。`),
          )
        : null,
      oc.asked >= 2
        ? h(
            "section",
            { class: "section", "data-section": "foil-check" },
            h("h2", {}, "架空の名前チェック"),
            h("p", {}, ocText),
            h("ul", { class: "reveal" }, ...foilSteps.map((s) => h("li", {}, `${s.item.text}（${s.item.hint}）→ 「${s.item.options[s.answer]}」`))),
          )
        : null,
      checkForm(v),
      h(
        "section",
        { class: "section" },
        h("h2", {}, "シェアする"),
        h(
          "div",
          { class: "btn-row" },
          h("button", { class: "btn btn-primary", type: "button", "data-action": "share-x" }, "X でシェア"),
          h("button", { class: "btn", type: "button", "data-action": "share-image" }, "画像でシェア"),
          h("button", { class: "btn", type: "button", "data-action": "again" }, "もう一度"),
        ),
        preview,
      ),
      h("details", { class: "section" }, h("summary", {}, `答えた問題を見る（${n}問）`), answersList),
    ];
    root.replaceChildren(...sections.filter((x): x is HTMLElement => x !== null));
    root.dataset.resultUrl = resultUrl;
    verdictEl.focus({ preventScroll: true });
  }

  function checkForm(v: Verdict): HTMLElement {
    const select = h("select", { id: "check-main", name: "main", required: true }, h("option", { value: "" }, "選んでください"));
    for (const t of teams) select.append(h("option", { value: t.id }, t.full));
    select.append(h("option", { value: "none" }, "贔屓の球団はない（野球は見る）"), h("option", { value: "nobaseball" }, "野球はあまり見ない"));
    const checks = h("div", { class: "checks" });
    for (const t of teams) checks.append(h("label", {}, h("input", { type: "checkbox", name: "others", value: t.id }), t.name));
    const note = deps.api.enabled
      ? "送るのは、当てた結果・本当の答え・各質問の答えだけです。人数として足し合わせるだけで、だれの答えかは残りません。次の人がもっと当たるように使います。"
      : "（この画面では答え合わせを送りません。当たったかどうかだけ表示します）";
    const form = h(
      "form",
      { class: "form-grid", "data-form": "check" },
      h("div", { class: "field" }, h("label", { for: "check-main" }, "本当の本命は？"), select),
      h("fieldset", { class: "field" }, h("legend", {}, "ほかにも好きな球団があれば（3つまで）"), checks),
      h("p", { class: "small" }, note),
      h("div", {}, h("button", { class: "btn btn-primary", type: "submit" }, "答え合わせする")),
    );
    const out = h("p", { class: "thanks", role: "status" });
    select.addEventListener("change", () => {
      const disableAll = select.value === "none" || select.value === "nobaseball";
      checks.querySelectorAll<HTMLInputElement>("input").forEach((c) => {
        c.disabled = disableAll || c.value === select.value;
        if (c.disabled) c.checked = false;
      });
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const main = select.value;
      if (!main) {
        out.textContent = "本命を選んでください。";
        return;
      }
      const others = [...checks.querySelectorAll<HTMLInputElement>("input:checked")].map((c) => c.value).filter((id) => id !== main);
      if (others.length > 3) {
        out.textContent = "ほかに好きな球団は3つまでにしてください。";
        return;
      }
      const j = judge(v, teams, main, others);
      out.textContent = j === "hit" ? "当たりでした！" : j === "near" ? "惜しい！ 2番手の球団でした。" : "はずれでした…。";
      form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, button").forEach((el) => (el.disabled = true));
      if (deps.api.enabled && deps.sentStore?.has(deps.bank.version)) {
        out.textContent += "（この端末からは、もう答え合わせを送っているので、今回は数えません）";
      } else if (deps.api.enabled) {
        const payload: ResultPayload = {
          v: deps.bank.version,
          guess: outcomeKey(teams, v.outcome),
          actual: { main, others },
          answers: session.answers.map((a) => ({ q: a.itemId, a: a.answer })),
        };
        void deps.api.record(payload).then((ok) => {
          if (ok) deps.sentStore?.mark(deps.bank.version);
          out.textContent += ok ? " 答え合わせを送りました。ありがとうございます。" : "（送れませんでしたが、ゲームには影響ありません）";
        });
      }
    });
    return h("section", { class: "section" }, h("h2", {}, "答え合わせ"), form, out);
  }

  async function shareImage(preview: HTMLElement): Promise<void> {
    if (!finalVerdict) return;
    const shares = fanShare(model, session.post);
    const card: ShareCard = {
      headline: headline(teams, finalVerdict),
      sub: `${steps.length}問・確信度 ${pct(finalVerdict.confidence)}`,
      // 画像の盤面は暗い緑なので、暗い背景用の球団カラーを使う
      bars: teams.map((t, i) => ({ name: t.name, color: t.colorDark, p: shares[i]! })).sort((a, b) => b.p - a.p),
      url: `${deps.siteUrl.replace(/^https?:\/\//, "")}`,
    };
    if (deps.shareImage) await deps.shareImage(card, preview);
  }

  root.addEventListener("click", (ev) => {
    const target = (ev.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!target || !root.contains(target)) return;
    const action = target.dataset.action;
    if (action === "start" || action === "again") start();
    else if (action === "answer") choose(Number(target.dataset.a));
    else if (action === "back") back();
    else if (action === "share-x" && finalVerdict) {
      const text = shareText(teams, finalVerdict, steps.length);
      openUrl(
        `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(root.dataset.resultUrl ?? deps.siteUrl)}&hashtags=${encodeURIComponent("12球団当て")}`,
      );
    } else if (action === "share-image") {
      const preview = root.querySelector<HTMLElement>(".share-area");
      if (preview) void shareImage(preview);
    }
  });

  return {
    start,
    /** テスト用: 今の状態 */
    state: () => ({ session, current, steps, verdict: finalVerdict }),
  };
}
