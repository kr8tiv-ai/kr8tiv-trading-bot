import { keyring } from "@zowe/secrets-for-zowe-sdk";
import type { Secret, SecretName } from "@kr8tiv/shared-types";
import { wrap } from "./secret.js";
import { SecretNotFoundError } from "./errors.js";

const DEFAULT_SERVICE_PREFIX = "kr8tiv-mexc-bot";

/**
 * Map SecretName (kebab) to account-name (screaming snake) used as the second arg to
 * keyring.getPassword(service, account). Account is arbitrary but must be stable.
 */
const USER_NAMES: Record<SecretName, string> = {
  "mexc-spot-access":    "MEXC_SPOT_ACCESS",
  "mexc-spot-secret":    "MEXC_SPOT_SECRET",
  "mexc-whitelist-ip":   "MEXC_WHITELIST_IP",
  "telegram-bot-token":  "TELEGRAM_BOT_TOKEN",
  "mexc-futures-access": "MEXC_FUTURES_ACCESS",
  "mexc-futures-secret": "MEXC_FUTURES_SECRET",
};

export interface SecretProvider {
  get(name: SecretName): Promise<Secret<string>>;
  has(name: SecretName): Promise<boolean>;
  list(): Promise<SecretName[]>;
  set(name: SecretName, value: string): Promise<void>;
  delete(name: SecretName): Promise<void>;
}

export interface WindowsCredentialManagerProviderOptions {
  /** Service name prefix; defaults to "kr8tiv-mexc-bot". Tests override to "kr8tiv-mexc-bot-test". */
  servicePrefix?: string;
}

export class WindowsCredentialManagerProvider implements SecretProvider {
  private readonly servicePrefix: string;

  constructor(options: WindowsCredentialManagerProviderOptions = {}) {
    this.servicePrefix = options.servicePrefix ?? DEFAULT_SERVICE_PREFIX;
  }

  private service(name: SecretName): string {
    return `${this.servicePrefix}/${name}`;
  }
  private account(name: SecretName): string {
    return USER_NAMES[name];
  }

  async get(name: SecretName): Promise<Secret<string>> {
    const value = await keyring.getPassword(this.service(name), this.account(name));
    if (value === null || value === undefined) {
      throw new SecretNotFoundError(name);
    }
    return wrap(value);
  }

  async has(name: SecretName): Promise<boolean> {
    const value = await keyring.getPassword(this.service(name), this.account(name));
    return value !== null && value !== undefined;
  }

  async list(): Promise<SecretName[]> {
    const allNames = Object.keys(USER_NAMES) as SecretName[];
    const results = await Promise.all(
      allNames.map(async (n) => ({ n, ok: await this.has(n) })),
    );
    return results.filter((x) => x.ok).map((x) => x.n);
  }

  async set(name: SecretName, value: string): Promise<void> {
    await keyring.setPassword(this.service(name), this.account(name), value);
  }

  async delete(name: SecretName): Promise<void> {
    await keyring.deletePassword(this.service(name), this.account(name));
  }
}
