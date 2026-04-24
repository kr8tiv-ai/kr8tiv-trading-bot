import { MEXCFuturesClient } from "@kr8tiv/mexc-futures";
import {
  WindowsCredentialManagerProvider,
  type SecretProvider,
} from "@kr8tiv/secrets";
import type { MexcFuturesAccountSnapshot } from "@kr8tiv/shared-schemas";

export const FUTURES_STATUS_MISSING_CREDENTIALS_MESSAGE =
  "Missing futures credentials in Windows Credential Manager: mexc-futures-access and/or mexc-futures-secret. Add read-only futures API credentials before using pnpm futures:status.";

export type FuturesAccountStatus =
  | {
      available: true;
      snapshot: MexcFuturesAccountSnapshot;
    }
  | {
      available: false;
      reason: "missing_credentials";
      message: string;
    };

export interface ReadFuturesAccountStatusOptions {
  secrets?: SecretProvider;
  createClient?: (
    secrets: SecretProvider,
  ) => Promise<Pick<MEXCFuturesClient, "fetchAccountSnapshot">>;
}

export async function readFuturesAccountStatus(
  options: ReadFuturesAccountStatusOptions = {},
): Promise<FuturesAccountStatus> {
  const secrets = options.secrets ?? new WindowsCredentialManagerProvider();
  const createClient =
    options.createClient ??
    ((provider: SecretProvider) => MEXCFuturesClient.create({ secrets: provider }));

  const [hasAccess, hasSecret] = await Promise.all([
    secrets.has("mexc-futures-access"),
    secrets.has("mexc-futures-secret"),
  ]);

  if (!hasAccess || !hasSecret) {
    return {
      available: false,
      reason: "missing_credentials",
      message: FUTURES_STATUS_MISSING_CREDENTIALS_MESSAGE,
    };
  }

  const client = await createClient(secrets);
  return {
    available: true,
    snapshot: await client.fetchAccountSnapshot(),
  };
}
