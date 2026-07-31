import { getMatchmakerEnv, type MatchmakerEnv } from '@arena/env/server';

export type Config = MatchmakerEnv;

export const config: Config = getMatchmakerEnv();
