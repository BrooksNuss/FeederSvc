export interface FeederSqsMessage {
	type: FeederApiType;
	id: string;
	fields?: UpdateFields
}

export type FeederApiType = 'activate' | 'list-info' | 'skip' | 'toggle-enabled' | 'update';
export type FeederApiResources = '/activate/{id}' | '/list-info' | '/skip/{id}' | '/toggle-enabled/{id}' | '/update/{id}' | '/postaction/{id}';
export type FeederUpdateAction = 'update' | 'activate' | 'skip';

export interface UpdateFields {
    id?: string;
    name?: string;
    status?: 'ONLINE' | 'OFFLINE';
    interval?: string;
    estRemainingFood?: number;
	description?: string;
	estRemainingFeedings?: number;
}

export interface FeederUpdateRequest {
	id: string,
	action: FeederUpdateAction,
	fields?: UpdateFields
}