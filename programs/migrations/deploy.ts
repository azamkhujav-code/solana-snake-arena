/**
 * Post-deploy bootstrap.
 *
 * `anchor deploy` only uploads the program; the config PDA still has to be
 * initialised once per cluster. Runs idempotently so re-running after a failed
 * deploy is safe.
 *
 * TODO: implement — check whether the config PDA exists, and call initialize()
 * only if it does not.
 */
export default async function deploy(): Promise<void> {
  throw new Error('Not implemented');
}
