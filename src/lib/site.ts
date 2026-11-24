// ページ（ビルド時）から質問データを引くための薄い窓口。
import bankJson from "../generated/bank.json";
import type { Bank, Team } from "./types";

export const bank = bankJson as unknown as Bank;
export const loadTeams = (): Team[] => bank.teams;
