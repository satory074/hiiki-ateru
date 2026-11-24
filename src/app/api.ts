// 答え合わせの送り先。画面（game.ts）はこの I/F だけを知り、テスト（domtest）は偽物を差し込む。
//
// 送るのは「当てた結果・本当の答え・各質問の答え」だけ（ResultPayload）。名前も端末の情報も送らない。
// 受け取る Supabase 側の関数（supabase/migrations/001_hiiki.sql の hiiki_record_result）は、
// 値を検査してから人数を足すだけで、一人ひとりの回答・IP・時刻は保存しない。
// 送れなくてもゲームには影響させない（黙って諦める）。

export interface ResultPayload {
  /** モデルの版（bank.version） */
  v: string;
  /** 当てた結果: 球団 id / multi / neutral / none */
  guess: string;
  actual: {
    /** 本命の球団 id、または none（贔屓なし・野球は見る）/ nobaseball（野球は見ない） */
    main: string;
    /** ほかに好きな球団（本命は含めない。3 つまで） */
    others: string[];
  };
  answers: { q: string; a: number }[];
}

export interface ResultApi {
  readonly enabled: boolean;
  record(p: ResultPayload): Promise<boolean>;
}

export const nullApi: ResultApi = {
  enabled: false,
  record: async () => false,
};

/** Supabase の公開 RPC を素の fetch で呼ぶ（SDK は入れない。moshirasu と同じ方式） */
export function supabaseApi(url: string, anonKey: string, fetchImpl: typeof fetch = fetch): ResultApi {
  const endpoint = `${url.replace(/\/$/, "")}/rest/v1/rpc/hiiki_record_result`;
  return {
    enabled: true,
    async record(p) {
      try {
        const res = await fetchImpl(endpoint, {
          method: "POST",
          headers: { apikey: anonKey, Authorization: `Bearer ${anonKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ p }),
          keepalive: true,
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
