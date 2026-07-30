export const MAX_PROXY_PAYLOAD_CHARS: number = 6 * 1024 * 1024;

export interface BridgeErrorBody {
  code: string;
  message: string;
}

interface BridgeSuccessEnvelope {
  ok: boolean;
  value: Object | null;
}

interface BridgeFailureEnvelope {
  ok: boolean;
  error: BridgeErrorBody;
}

export class BridgeFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BridgeFailure';
    this.code = code;
  }
}

export function bridgeSuccess(value: Object | null): string {
  const envelope: BridgeSuccessEnvelope = { ok: true, value };
  return JSON.stringify(envelope);
}

export function bridgeFailure(code: string, message: string): string {
  const error: BridgeErrorBody = { code, message };
  const envelope: BridgeFailureEnvelope = { ok: false, error };
  return JSON.stringify(envelope);
}

export interface BridgeDelegate {
  dispatch(method: string, payload: Object): Promise<Object | null>;
}
