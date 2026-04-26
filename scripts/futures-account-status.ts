import { MEXCFuturesClient } from "@kr8tiv/mexc-futures";
import { type SecretProvider, WindowsCredentialManagerProvider } from "@kr8tiv/secrets";
import type { MexcFuturesAccountSnapshot } from "@kr8tiv/shared-schemas";

export const FUTURES_STATUS_MISSING_CREDENTIALS_MESSAGE =
  "Missing MEXC credentials in Windows Credential Manager: provide mexc-futures-access/secret or a full-permission mexc-spot-access/secret key pair before using pnpm futures:status.";

export type FuturesAccountStatus =
  | {
      available: true;
      snapshot: MexcFuturesAccountSnapshot;
    }
  | {
      available: false;
      reason: "missing_credentials";
      message: string;
    }
  | {
      available: false;
      reason: "api_rejected";
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

  const [hasFuturesAccess, hasFuturesSecret, hasSpotAccess, hasSpotSecret] = await Promise.all([
    secrets.has("mexc-futures-access"),
    secrets.has("mexc-futures-secret"),
    secrets.has("mexc-spot-access"),
    secrets.has("mexc-spot-secret"),
  ]);

  if (!(hasFuturesAccess && hasFuturesSecret) && !(hasSpotAccess && hasSpotSecret)) {
    return {
      available: false,
      reason: "missing_credentials",
      message: FUTURES_STATUS_MISSING_CREDENTIALS_MESSAGE,
    };
  }

  try {
    const client = await createClient(secrets);
    return {
      available: true,
      snapshot: await client.fetchAccountSnapshot(),
    };
  } catch (err) {
    return {
      available: false,
      reason: "api_rejected",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
