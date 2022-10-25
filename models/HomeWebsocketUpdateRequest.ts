import { FeederInfo } from './FeederInfo';

export interface HomeWebsocketUpdateRequest {
	action: HomeWebsocketUpdateActionType,
	type: HomeWebsocketUpdateRequestType,
	value: FeederInfo;
}

export type HomeWebsocketUpdateActionType = 'sendNotification' | 'broadcastNotification';
export type HomeWebsocketUpdateRequestType = 'feederUpdate';