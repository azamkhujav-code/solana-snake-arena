import { getGatewayEnv, type GatewayEnv } from '@arena/env/server';

export type Config = GatewayEnv;

/** Validated once at boot; throws with every problem listed if misconfigured. */
export const config: Config = getGatewayEnv();
