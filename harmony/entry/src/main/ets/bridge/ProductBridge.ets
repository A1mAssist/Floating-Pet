import {
  BridgeDelegate,
  BridgeFailure,
  MAX_PROXY_PAYLOAD_CHARS,
  bridgeFailure,
  bridgeSuccess
} from './BridgeTypes';

export class ProductBridge {
  private readonly delegate: BridgeDelegate;

  constructor(delegate: BridgeDelegate) {
    this.delegate = delegate;
  }

  async invoke(method: string, payloadJson: string): Promise<string> {
    if (!this.isKnownMethod(method) || payloadJson.length > MAX_PROXY_PAYLOAD_CHARS) {
      return bridgeFailure('invalid_input', '请求无效。');
    }

    let payload: Object;
    try {
      const candidate: Object | null = JSON.parse(payloadJson) as Object | null;
      if (candidate === null || Array.isArray(candidate) || typeof candidate !== 'object') {
        return bridgeFailure('invalid_input', '请求无效。');
      }
      payload = candidate;
    } catch {
      return bridgeFailure('invalid_input', '请求无效。');
    }

    try {
      const value: Object | null = await this.delegate.dispatch(method, payload);
      return bridgeSuccess(value);
    } catch (error) {
      if (error instanceof BridgeFailure) return bridgeFailure(error.code, error.message);
      console.error(`[FloatPet] NATIVE_DISPATCH_FAILED method=${method}`);
      return bridgeFailure('native_error', '系统能力暂不可用。');
    }
  }

  private isKnownMethod(method: string): boolean {
    switch (method) {
      case 'window.beginDrag':
      case 'window.moveDrag':
      case 'window.endDrag':
      case 'window.setClickThrough':
      case 'window.focus':
      case 'capture.listSources':
      case 'capture.selectSource':
      case 'capture.frame':
      case 'model.capabilities':
      case 'model.chat':
      case 'model.analyzeScreen':
      case 'model.cancelScreenAnalysis':
      case 'realtime.start':
      case 'realtime.append':
      case 'realtime.stop':
      case 'app.updateState':
      case 'app.rendererReady':
      case 'app.quit':
        return true;
      default:
        return false;
    }
  }
}
