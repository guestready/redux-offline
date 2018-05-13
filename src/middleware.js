// @flow

import type { AppState, Config, OfflineAction, ResultAction } from './types';
import {
  OFFLINE_SEND,
  OFFLINE_SCHEDULE_RETRY,
  OFFLINE_SEND_RESULT,
  JS_ERROR
} from './constants';
import { scheduleRetry, completeRetry } from './actions';
import send from './send';

const after = (timeout = 0) =>
  new Promise(resolve => setTimeout(resolve, timeout));

const complete = (
  action: ResultAction,
  success: boolean,
  payload: {},
  offlineAction: OfflineAction,
  config: Config
): ResultAction => {
  const { resolveAction, rejectAction } = config.offlineActionTracker;
  if (success) {
    resolveAction(offlineAction.meta.transaction, payload);
  } else {
    rejectAction(offlineAction.meta.transaction, payload);
  }
  return {
    ...action,
    payload,
    meta: { ...action.meta, success, completed: true }
  };
};

const processResult = async (resultAction, config, retries) => {
  const { meta: { action } } = resultAction;
  const { meta: { offline: metadata } } = action;

  if (resultAction.meta.success) {
    const commitAction = metadata.commit || {
      ...config.defaultCommit,
      meta: { ...config.defaultCommit.meta, offlineAction: action }
    };
    try {
      return complete(commitAction, true, resultAction.payload, action, config);
    } catch (error) {
      return complete(
        { type: JS_ERROR, meta: { error } },
        false,
        undefined,
        action,
        config
      );
    }
  } else {
    const error = resultAction.meta.error;
    const rollbackAction = metadata.rollback || {
      ...config.defaultRollback,
      meta: { ...config.defaultRollback.meta, offlineAction: action }
    };

    // discard
    let mustDiscard = true;
    try {
      mustDiscard = await config.discard(error, action, retries);
    } catch (e) {
      console.warn(e);
    }

    if (!mustDiscard) {
      const delay = config.retry(action, retries);
      if (delay != null) {
        return scheduleRetry(delay);
      }
    }

    return complete(rollbackAction, false, error, action, config);
  }
};

export const createOfflineMiddleware = (config: Config) => (store: any) => (
  next: any
) => (action: any) => {
  // allow other middleware to do their things
  const result = next(action);
  let promise;
  // find any actions to send, if any
  const state: AppState = store.getState();
  const offline = config.offlineStateLens(state).get;
  const offlineAction = config.queue.peek(offline.outbox);

  // process result of any previous OFFLINE_SEND action
  if (action.type === OFFLINE_SEND_RESULT) {
    processResult(action, config, offline.retryCount)
      .then(store.dispatch)
      .catch(e => console.warn(e));
    return;
  }

  // create promise to return on enqueue offline action
  if (action.meta && action.meta.offline) {
    const { registerAction } = config.offlineActionTracker;
    promise = registerAction(offline.lastTransaction);
  }

  // if there are any actions in the queue that we are not
  // yet processing, send those actions
  if (
    offlineAction &&
    !offline.busy &&
    !offline.retryScheduled &&
    offline.online
  ) {
    send(offlineAction, store.dispatch, config, offline.retryCount);
  }

  if (action.type === OFFLINE_SCHEDULE_RETRY) {
    after(action.payload.delay).then(() => {
      store.dispatch(completeRetry(offlineAction));
    });
  }

  if (action.type === OFFLINE_SEND && offlineAction && !offline.busy) {
    send(offlineAction, store.dispatch, config, offline.retryCount);
  }

  return promise || result;
};
