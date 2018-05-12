import { offlineSendResult, offlineSend } from './actions';
import type { Config, OfflineAction } from './types';

const send = (action: OfflineAction, dispatch, config: Config, retries = 0) => {
  dispatch(offlineSend(action));
  if (config.effect) {
    const metadata = action.meta.offline;
    return config
      .effect(metadata.effect, action)
      .then(result => dispatch(offlineSendResult(action, true)))
      .catch(async error => dispatch(offlineSendResult(action, false, error)));
  }
};

export default send;
