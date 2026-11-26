export {isRequestWithdrawal} from './messaging/withdrawalIntent.service.js';
export const requestWasWithdrawn = conversation => {
  const state = conversation?.conversationMemory?.recoveryIntake;
  return Boolean(state?.withdrawnAt && state.journeyKey === (conversation?.orchestration?.recoveryJourneyKey || ''));
};
