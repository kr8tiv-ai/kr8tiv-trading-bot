import type { SecretName } from "@kr8tiv/shared-types";

export class SecretNotFoundError extends Error {
  override readonly name: string = "SecretNotFoundError";
  readonly secretName: SecretName;

  constructor(secretName: SecretName) {
    super(`Secret not found in credential store: ${secretName}`);
    this.secretName = secretName;
  }
}
