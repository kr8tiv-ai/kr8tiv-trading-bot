/**
 * Allow-list union of known Windows Credential Manager secret names for
 * kr8tiv-mexc-bot. Every secret the app ever reads MUST appear here.
 *
 * Naming convention: lowercase kebab-case; used as the final path component
 * of the Credential Manager service name `kr8tiv-mexc-bot/<name>`.
 *
 * Phase 1: mexc-spot-access, mexc-spot-secret, mexc-whitelist-ip (all 3 already provisioned)
 * Phase 3 adds: telegram-bot-token
 * Phase 6 adds: mexc-futures-access, mexc-futures-secret
 */
export type SecretName =
  | "mexc-spot-access"
  | "mexc-spot-secret"
  | "mexc-whitelist-ip"
  | "telegram-bot-token"
  | "mexc-futures-access"
  | "mexc-futures-secret";

/**
 * Branded primitive type representing a secret value. Prevents accidental
 * leakage through logging or serialization — unwrapping requires an explicit
 * `unsafeReveal()` call (grep-able).
 *
 * Implementation in packages/secrets is the only place that mints these.
 */
declare const SecretBrand: unique symbol;
export type Secret<T extends string = string> = T & { readonly [SecretBrand]: true };
