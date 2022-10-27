import { FeederInfo } from './FeederInfo';

export interface HomeWSSendNotificationRequest {
	action: HomeWSActionType,
	subscriptionType: HomeWSSubscriptionType,
	value: FeederInfo;
}

export type HomeWSActionType = 'sendNotification';
export type HomeWSSubscriptionType = 'feederUpdate';