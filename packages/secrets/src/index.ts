export type { Secret, SecretName } from "@kr8tiv/shared-types";
export { wrap, unsafeReveal } from "./secret.js";
export { SecretNotFoundError } from "./errors.js";
export {
  type SecretProvider,
  type WindowsCredentialManagerProviderOptions,
  WindowsCredentialManagerProvider,
} from "./provider.js";
