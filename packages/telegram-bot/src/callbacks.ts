import {
  TelegramApprovalCallbackSchema,
  type TelegramApprovalCallback,
} from "@kr8tiv/shared-schemas";

const VERSION = "ap1";
const APPROVE_CODE = "a";
const REJECT_CODE = "r";

function encodeAction(action: TelegramApprovalCallback["action"]): string {
  return action === "approve" ? APPROVE_CODE : REJECT_CODE;
}

function decodeAction(code: string): TelegramApprovalCallback["action"] | null {
  if (code === APPROVE_CODE) return "approve";
  if (code === REJECT_CODE) return "reject";
  return null;
}

export function encodeApprovalCallbackData(
  payload: Omit<TelegramApprovalCallback, "version">,
): string {
  const data = [
    VERSION,
    encodeAction(payload.action),
    payload.signalId,
    payload.issuedAtMs.toString(36),
  ].join(":");
  if (data.length > 64) {
    throw new Error(
      `callback_data exceeds Telegram 64-byte limit (${data.length})`,
    );
  }
  return data;
}

export function decodeApprovalCallbackData(
  data: string,
): TelegramApprovalCallback | null {
  const [version, actionCode, signalId, issuedAtBase36] = data.split(":");
  if (
    version === undefined ||
    actionCode === undefined ||
    signalId === undefined ||
    issuedAtBase36 === undefined
  ) {
    return null;
  }
  const action = decodeAction(actionCode);
  if (version !== VERSION || action === null) return null;

  const issuedAtMs = Number.parseInt(issuedAtBase36, 36);
  const parsed = TelegramApprovalCallbackSchema.safeParse({
    version,
    action,
    signalId,
    issuedAtMs,
  });
  return parsed.success ? parsed.data : null;
}
