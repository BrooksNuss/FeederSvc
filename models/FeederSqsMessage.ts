export interface FeederSqsMessage {
	type: FeederSqsMessageType;
	id: string;
}

export type FeederSqsMessageType = 'activate';
export type FeederApiResources = '/activate/{id}' | '/list-info' | '/skip/{id}' | '/toggle-enabled/{id}' | '/update/{id}' | '/post-activation/{id}';
export type FeederUpdateAction = 'update' | 'activate';

export interface UpdateFields {
    id?: string;
    name?: string;
    enabled?: boolean;
    interval?: string;
    estRemainingFood?: number;
	description?: string;
	estRemainingFeedings?: number;
	skipNext?: boolean;
}

export interface FeederUpdateRequest {
	id: string,
	action: FeederUpdateAction,
	fields?: UpdateFields
}

export interface UserUpdatableFields {
	id?: string;
    name?: string;
    enabled?: boolean;
    interval?: string;
    estRemainingFood?: number;
	description?: string;
}