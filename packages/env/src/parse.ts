import type { z } from 'zod';

export class EnvValidationError extends Error {
  public readonly issues: readonly string[];

  constructor(scope: string, issues: readonly string[]) {
    super(
      `Invalid environment for "${scope}":\n` +
        issues.map((issue) => `  - ${issue}`).join('\n') +
        `\n\nCheck .env.example for the expected shape.`,
    );
    this.name = 'EnvValidationError';
    this.issues = issues;
  }
}

/**
 * Validates `source` against `schema` and throws a single, readable error
 * listing every problem at once.
 *
 * Services call this at boot so a misconfigured deploy fails immediately
 * instead of surfacing as a null-pointer three layers deep at request time.
 */
export function parseEnv<TSchema extends z.ZodType>(
  scope: string,
  schema: TSchema,
  source: Record<string, string | undefined> = process.env,
): z.infer<TSchema> {
  const result = schema.safeParse(source);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.join('.') || '(root)';
      return `${path}: ${issue.message}`;
    });
    throw new EnvValidationError(scope, issues);
  }

  return result.data;
}

/**
 * Lazily validates env so that importing a module does not immediately read
 * `process.env`. Useful in tests and in Next.js, where client bundles must not
 * evaluate server schemas at import time.
 */
export function lazyEnv<TSchema extends z.ZodType>(
  scope: string,
  schema: TSchema,
  source: () => Record<string, string | undefined> = () => process.env,
): () => z.infer<TSchema> {
  let cached: z.infer<TSchema> | undefined;
  return () => {
    cached ??= parseEnv(scope, schema, source());
    return cached;
  };
}
