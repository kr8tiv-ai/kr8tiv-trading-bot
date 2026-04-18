import type { Secret } from "@kr8tiv/shared-types";

/** Mint a Secret<T>. Only SecretProvider impls should call this. */
export function wrap<T extends string>(value: T): Secret<T> {
  return value as Secret<T>;
}

/**
 * Unwrap a Secret to its raw string. Named `unsafeReveal` so that:
 * (a) every call site is grep-able,
 * (b) reviewers notice when a secret crosses a boundary.
 *
 * Do NOT call this except at the immediate site of passing to an SDK (CCXT, grammY, etc.).
 */
export function unsafeReveal(s: Secret<string>): string {
  return s as string;
}

// Re-export for convenience so callers can `import type { Secret } from "@kr8tiv/secrets/secret"`.
export type { Secret };
